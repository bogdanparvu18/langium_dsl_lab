import type { CancellationToken } from 'vscode-languageserver';

export interface RxNormSearchOptions { enabled: boolean; url: string; release: string }
export interface RxNormProduct { rxcui: string; display: string; tty: 'SCD' | 'SBD'; release: string }
export interface RxNormProductResults { items: RxNormProduct[]; hasMore: boolean }

/** Only a loopback terminology endpoint is accepted. No source document is sent. */
export function searchOptions(value: unknown): RxNormSearchOptions | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const options = value as Partial<RxNormSearchOptions>;
    if (options.enabled !== true || typeof options.url !== 'string' || typeof options.release !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(options.release) || options.release.startsWith('0000-') ||
        !Number.isFinite(Date.parse(options.release)) || new Date(options.release).toISOString().slice(0, 10) !== options.release) return undefined;
    try {
        const url = new URL(options.url);
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
            url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
        return { enabled: true, url: url.origin, release: options.release };
    } catch { return undefined; }
}

const EMPTY: RxNormProductResults = { items: [], hasMore: false };

/** Short-lived prefix results; not a clinical-resolution cache. */
export class RxNormProductSearch {
    private readonly cache = new Map<string, { expires: number; result: RxNormProductResults }>();
    constructor(
        private readonly fetcher: typeof fetch = globalThis.fetch,
        private readonly debounceMs = 200,
        private readonly timeoutMs = 2000
    ) {}

    clear(): void { this.cache.clear(); }

    async search(query: string, options: RxNormSearchOptions, token?: CancellationToken): Promise<RxNormProductResults> {
        const normalized = query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
        if (!searchOptions(options) || normalized.length < 2 || normalized.length > 100 || token?.isCancellationRequested) return EMPTY;
        const key = JSON.stringify([options.url, options.release, normalized]);
        const cached = this.cache.get(key);
        if (cached && cached.expires > Date.now()) return cached.result;
        this.cache.delete(key);
        const controller = new AbortController();
        const subscription = token?.onCancellationRequested(() => controller.abort());
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await new Promise<void>(resolve => {
                const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
                const timer = setTimeout(finish, this.debounceMs);
                controller.signal.addEventListener('abort', finish, { once: true });
                if (controller.signal.aborted) finish();
            });
            if (controller.signal.aborted) return EMPTY;
            timeout = setTimeout(() => controller.abort(), this.timeoutMs);
            const url = new URL('/products', options.url);
            url.searchParams.set('release', options.release);
            url.searchParams.set('q', normalized);
            url.searchParams.set('limit', '20');
            const response = await this.fetcher(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
            if (!response.ok || controller.signal.aborted) return EMPTY;
            // The bounded response avoids retaining an unexpectedly large terminology dump.
            const raw = await response.text();
            if (raw.length > 100_000 || controller.signal.aborted) return EMPTY;
            const payload = JSON.parse(raw);
            if (payload?.schemaVersion !== '1' || payload.release !== options.release || payload.query !== normalized ||
                !Array.isArray(payload.items) || payload.items.length > 20 || typeof payload.hasMore !== 'boolean') return EMPTY;
            const ids = new Set<string>();
            const valid = payload.items.every((item: RxNormProduct) => {
                if (!item || typeof item.rxcui !== 'string' || !/^[1-9][0-9]{0,19}$/.test(item.rxcui) ||
                    typeof item.display !== 'string' || !item.display.trim() || item.display.length > 2000 ||
                    !['SCD', 'SBD'].includes(item.tty) || item.release !== options.release || ids.has(item.rxcui)) return false;
                ids.add(item.rxcui);
                return true;
            });
            if (!valid || controller.signal.aborted) return EMPTY;
            const result: RxNormProductResults = {
                items: payload.items.map((item: RxNormProduct) => ({ rxcui: item.rxcui, display: item.display, tty: item.tty, release: item.release })),
                hasMore: payload.hasMore
            };
            if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(key, { expires: Date.now() + 60_000, result });
            return result;
        } catch { return EMPTY; }
        finally { if (timeout) clearTimeout(timeout); subscription?.dispose(); }
    }
}
