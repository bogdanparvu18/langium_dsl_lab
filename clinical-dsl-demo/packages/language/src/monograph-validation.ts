import { AstUtils, GrammarUtils, URI, type ValidationAcceptor } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import { type CancellationToken, type Range } from 'vscode-languageserver';
import type { Medication } from './generated/ast.js';
import { hasExactDoseValue } from './dose-precision.js';
import { normalizeFrequency } from './frequency.js';
import { readMonographSource } from './monograph-source.js';
import { searchOptions } from './rxnorm-product-search.js';

type Field = 'dose' | 'frequency' | 'source';
interface Issue { field: Field; message: string }
interface Result { status: 'valid' | 'invalid' | 'unverified'; issues: Issue[]; page?: number }

const unavailable = 'Could not verify dose and frequency against the selected monograph. Check the local Scala service and cached PDF, then save to retry.';

function validResult(value: unknown): value is Result {
    if (!value || typeof value !== 'object') return false;
    const reply = value as Partial<Result>;
    if (!Array.isArray(reply.issues) || reply.issues.length > 20 ||
        (reply.page !== undefined && (!Number.isSafeInteger(reply.page) || reply.page < 1))) return false;
    if (reply.status === 'valid') return reply.issues.length === 0;
    return (reply.status === 'unverified' || reply.status === 'invalid') && reply.issues.length > 0 &&
        reply.issues.every(i => i && (i.field === 'dose' || i.field === 'frequency' || i.field === 'source') &&
            typeof i.message === 'string' && i.message.trim().length > 0 && i.message.length <= 2000);
}

export function monographIssueRange(med: Medication, field: Field): Range | undefined {
    const property = field === 'dose' ? 'amount' : field === 'source' ? 'rxcui' : 'frequency';
    const first = GrammarUtils.findNodeForProperty(med.$cstNode, property);
    if (first && field === 'dose') {
        const unit = GrammarUtils.findNodeForProperty(med.$cstNode, 'unit');
        if (unit) return { start: first.range.start, end: unit.range.end };
    }
    return first?.range;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
    });
}

/** Only the configured, trusted editor invokes the Scala checker. The CLI uses
 * its own final Scala validation against the same pinned local PDF. */
export class MonographValidation {
    private enabled = false;
    private resourceConfiguration = false;
    private configuration?: { url?: string; release?: string };
    private epoch = 0;

    constructor(private readonly services: LangiumServices) {
        const shared = services.shared;
        const connection = shared.lsp.Connection;
        if (!connection) return;
        shared.lsp.LanguageServer.onInitialize(params => {
            this.enabled = params.initializationOptions?.monographValidation === true;
            this.configuration = params.initializationOptions?.rxnormSearch;
            this.resourceConfiguration = params.capabilities.workspace?.configuration === true;
        });
        connection.onNotification('clinical-dsl/configureMonographValidation', config => {
            this.configuration = config;
            this.epoch++;
            this.revalidate(shared.workspace.TextDocuments.all().filter(d => d.languageId === 'clinical-dsl').map(d => URI.parse(d.uri)));
        });
        connection.onNotification('clinical-dsl/recheckMonograph', (uri: string) => {
            if (typeof uri === 'string' && shared.workspace.TextDocuments.get(uri)?.languageId === 'clinical-dsl') {
                this.revalidate([URI.parse(uri)]);
            }
        });
    }

    private revalidate(uris: URI[]): void {
        if (this.enabled && uris.length) {
            const workspace = this.services.shared.workspace;
            void workspace.WorkspaceLock.write(token => workspace.DocumentBuilder.update(uris, [], token));
        }
    }

    async check(med: Medication, accept: ValidationAcceptor, cancellation: CancellationToken): Promise<void> {
        const selection = readMonographSource(med);
        const sourceIssue = (severity: 'error' | 'warning', message: string) => accept(severity, message, {
            node: med, property: med.rxcui ? 'rxcui' : 'name', code: 'monograph-source'
        });
        if (selection.status === 'invalid') { sourceIssue('error', selection.message); return; }
        if (!med.rxcui) return;
        if (selection.status === 'missing') {
            if (this.enabled) sourceIssue('warning', 'Dose and frequency are unverified. Confirm the Canadian presentation to attach its monograph.');
            return;
        }
        if (!this.enabled) {
            sourceIssue('warning', 'Dose and frequency require verification against the selected PDF by the local Scala validator.');
            return;
        }
        const { source } = selection;
        const document = AstUtils.getDocument(med);
        const uri = document.uri.toString();
        const version = document.textDocument.version;
        const epoch = this.epoch;
        const workspace = this.services.shared.workspace;
        const current = () => !cancellation.isCancellationRequested && epoch === this.epoch &&
            workspace.LangiumDocuments.getDocument(document.uri) === document &&
            (workspace.TextDocuments.get(uri)?.version ?? version) === version;
        if (!current()) return;
        const dose = med.unit && med.amount !== undefined && Number.isFinite(med.amount) && med.amount > 0 && hasExactDoseValue(med)
            ? { amount: med.amount, unit: med.unit } : undefined;
        const frequency = med.frequency && normalizeFrequency(med.frequency) || undefined;
        if (!dose && !frequency) return;
        const abort = new AbortController();
        const subscription = cancellation.onCancellationRequested(() => abort.abort());
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]);
        try {
            await delay(150, signal);
            if (!current()) return;
            let configured = this.configuration;
            if (this.resourceConfiguration) {
                const pending = this.services.shared.lsp.Connection!.workspace.getConfiguration({ scopeUri: uri, section: 'clinicalDsl.rxnorm' });
                // A disconnected configuration client must not retain the workspace write lock.
                const config = await Promise.race([pending, delay(900, signal).then(() => undefined)]);
                configured = config && { url: config.searchUrl, release: config.release };
            }
            if (!current()) return;
            const options = searchOptions({ enabled: true, url: configured?.url, release: configured?.release });
            if (!options) { sourceIssue('warning', unavailable); return; }
            if (options.release !== source.release) {
                sourceIssue('error', 'The monograph source belongs to another RxNorm release. Select the Canadian presentation again.');
                return;
            }
            const response = await fetch(new URL('/validate-regimen', options.url), {
                method: 'POST', redirect: 'error', signal,
                headers: { 'Content-Type': 'application/json', 'X-Aurora-Client': 'vscode', Accept: 'application/json' },
                body: JSON.stringify({ ...source, dose, frequency })
            });
            const result: unknown = response.ok ? await response.json() : undefined;
            if (!current()) return;
            if (!validResult(result)) { sourceIssue('warning', unavailable); return; }
            for (const issue of result.issues) {
                const page = result.page ? ', PDF p. ' + result.page : '';
                accept(result.status === 'invalid' ? 'error' : 'warning', `${issue.message} (DIN ${source.din}${page})`, {
                    node: med, range: monographIssueRange(med, issue.field), code: 'monograph-' + issue.field
                });
            }
        } catch {
            if (current()) sourceIssue('warning', unavailable);
        } finally {
            abort.abort();
            subscription.dispose();
        }
    }
}
