import { afterEach, describe, expect, test, vi } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { CancellationTokenSource, type CompletionItem, type TextEdit } from 'vscode-languageserver';
import { createClinicalDslServices } from '../src/clinical-dsl-module.js';
import { ClinicalDslCompletionProvider } from '../src/clinical-dsl-completion-provider.js';
import { RxNormProductSearch, searchOptions } from '../src/rxnorm-product-search.js';
import type { Model } from '../src/generated/ast.js';

const options = { enabled: true, url: 'http://127.0.0.1:8765', release: '2026-10-05' };
// Synthetic identifiers and labels exercise binding, not actual RxNorm data.
const product = { rxcui: '900001', display: 'Aspirin fixture product', tty: 'SCD', release: options.release };
function response(query = 'aspi', extra = {}) {
    return new Response(JSON.stringify({ schemaVersion: '1', release: options.release, query, items: [product], hasMore: false, ...extra }));
}
afterEach(() => vi.unstubAllGlobals());

describe('local RxNorm product search', () => {
    test('only accepts valid loopback origins and calendar releases', () => {
        expect(searchOptions(options)).toEqual(options);
        for (const url of ['https://127.0.0.1', 'http://example.com', 'http://127.0.0.1:8765/path', 'http://user:pass@localhost', 'http://localhost/?q=secret']) {
            expect(searchOptions({ ...options, url })).toBeUndefined();
        }
        expect(searchOptions({ ...options, release: '2026-02-30' })).toBeUndefined();
        expect(searchOptions({ ...options, release: '0000-01-01' })).toBeUndefined();
        expect(searchOptions({ ...options, enabled: false })).toBeUndefined();
    });

    test('sends only normalized prefix/release/limit and caches by release', async () => {
        const fetcher = vi.fn(async (url: URL) => response(url.searchParams.get('q')!, { release: url.searchParams.get('release'),
            items: [{ ...product, release: url.searchParams.get('release') }] }));
        const search = new RxNormProductSearch(fetcher as unknown as typeof fetch, 0);
        expect((await search.search('ASPI', options)).items).toHaveLength(1);
        expect((await search.search('aspi', options)).items).toHaveLength(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const request = fetcher.mock.calls[0][0];
        expect([...request.searchParams.keys()].sort()).toEqual(['limit', 'q', 'release']);
        expect(request.searchParams.get('q')).toBe('aspi');
        await search.search('aspi', { ...options, release: '2026-11-02' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('rejects mismatched release, unexpected type, duplicate IDs and invalid payload', async () => {
        const bad = [
            { release: '2026-11-02' }, { query: 'other' }, { items: [{ ...product, tty: 'IN' }] },
            { items: [product, product] }, { items: [{ ...product, rxcui: '0' }] },
            { items: [{ ...product, release: '2026-11-02' }] }, { hasMore: 'false' }
        ];
        for (const payload of bad) {
            const search = new RxNormProductSearch(async () => response('aspi', payload), 0);
            expect((await search.search('aspi', options)).items).toEqual([]);
        }
    });

    test('cancellation during debounce prevents the HTTP call', async () => {
        const fetcher = vi.fn(async () => response());
        const source = new CancellationTokenSource();
        const request = new RxNormProductSearch(fetcher, 100).search('aspi', options, source.token);
        source.cancel();
        expect((await request).items).toEqual([]);
        expect(fetcher).not.toHaveBeenCalled();
        source.dispose();
    });

    test('short prefix, HTTP error and offline service return no product suggestions', async () => {
        const fetcher = vi.fn(async () => new Response('', { status: 503 }));
        const search = new RxNormProductSearch(fetcher, 0);
        expect((await search.search('a', options)).items).toEqual([]);
        expect(fetcher).not.toHaveBeenCalled();
        expect((await search.search('aspi', options)).items).toEqual([]);
        const offline = new RxNormProductSearch(async () => { throw Error('offline'); }, 0);
        expect((await offline.search('aspi', options)).items).toEqual([]);
    });
});

async function complete(marked: string, mock = async () => response()) {
    vi.stubGlobal('fetch', mock);
    const offset = marked.indexOf('|');
    const text = marked.slice(0, offset) + marked.slice(offset + 1);
    const services = createClinicalDslServices(EmptyFileSystem);
    const provider = services.ClinicalDsl.lsp.CompletionProvider as ClinicalDslCompletionProvider;
    provider.configureRxNorm(options);
    const document = await parseHelper<Model>(services.ClinicalDsl)(text, { validation: true });
    const result = await provider.getCompletion(document, { textDocument: { uri: document.uri.toString() }, position: document.textDocument.positionAt(offset) });
    const item = result?.items.find(candidate => candidate.detail?.includes('RxCUI'));
    return { document, services, provider, result, item, text, offset };
}

function apply(item: CompletionItem, document: Awaited<ReturnType<typeof complete>>['document']): string {
    const edits = [item.textEdit as TextEdit, ...(item.additionalTextEdits ?? [])];
    const spans = edits.map(edit => ({ start: document.textDocument.offsetAt(edit.range.start), end: document.textDocument.offsetAt(edit.range.end), text: edit.newText }))
        .sort((a, b) => b.start - a.start);
    let text = document.textDocument.getText();
    for (let i = 0; i < spans.length; i++) {
        if (i) expect(spans[i].end).toBeLessThanOrEqual(spans[i - 1].start);
        text = text.slice(0, spans[i].start) + spans[i].text + text.slice(spans[i].end);
    }
    return text;
}

describe('product completion transactions', () => {
    test('new prefix becomes readable alias plus durable exact binding', async () => {
        const result = await complete('medication aspi|');
        expect(result.item).toBeDefined();
        const text = apply(result.item!, result.document);
        expect(text).toBe('medication Aspirin: rxcui "900001" rxnormRelease "2026-10-05"');
        const parsed = await parseHelper<Model>(result.services.ClinicalDsl)(text);
        expect(parsed.parseResult.parserErrors).toEqual([]);
        expect(parsed.parseResult.value.medication[0].rxcui).toBe('900001');
        expect(parsed.parseResult.value.medication[0].amount).toBeUndefined();
    });

    test('selecting a product preserves existing alias, fields, order and Plan references', async () => {
        const result = await complete('medication aspi|: frequency BID dose 10mg route PO strength "10mg" doseForm "Oral Tablet"\nPlan P: for A prescribe aspi');
        const text = apply(result.item!, result.document);
        expect(text).toContain('medication aspi: rxcui "900001" rxnormRelease "2026-10-05"');
        expect(text).toContain('frequency BID dose 10mg route PO strength "10mg" doseForm "Oral Tablet"');
        expect(text).toContain('prescribe aspi');
    });

    test('reselection replaces both binding values without duplicate fields', async () => {
        const result = await complete('medication aspi|: RXNORMRELEASE "2025-01-06" route po RXCUI "900002"');
        const text = apply(result.item!, result.document);
        expect(text).toBe('medication aspi: RXNORMRELEASE "2026-10-05" route po RXCUI "900001"');
    });

    test('typing a product prefix inside rxcui selects for an arbitrary existing alias', async () => {
        const result = await complete('medication MyMorningMed: route po rxcui "aspi|" dose 10mg frequency bid');
        const text = apply(result.item!, result.document);
        expect(text).toBe('medication MyMorningMed: rxnormRelease "2026-10-05"  route po rxcui "900001" dose 10mg frequency bid');
        expect(result.item!.textEdit).toMatchObject({ newText: '900001' });
    });

    test('rxcui reselection preserves single quotes and updates existing release', async () => {
        const result = await complete("medication MyMorningMed: rxcui 'aspi|rin' rxnormRelease '2025-01-06'");
        const text = apply(result.item!, result.document);
        expect(text).toBe('medication MyMorningMed: rxcui \'900001\' rxnormRelease "2026-10-05"');
        expect(text.match(/rxcui/g)).toHaveLength(1);
    });

    test('an incomplete binding label gets a value, not a duplicate label', async () => {
        const result = await complete('medication aspi|: rxcui');
        expect(apply(result.item!, result.document)).toBe('medication aspi: rxnormRelease "2026-10-05"  rxcui "900001"');
    });

    test('new alias avoids existing case-insensitive collisions', async () => {
        const result = await complete('medication ASPIRIN: dose 1mg route PO frequency QD\nmedication aspi|');
        expect(apply(result.item!, result.document)).toContain('medication Aspirin_900001:');
    });

    test('another incomplete Medication does not break alias collision checks', async () => {
        const result = await complete('medication :\nmedication aspi|');
        expect(result.item).toBeDefined();
        expect(apply(result.item!, result.document)).toContain('medication Aspirin: rxcui "900001"');
    });

    test('does not query from patient names, plan references, comments or values', async () => {
        for (const source of ['Patient aspi|: age 1, condition Fever', 'Plan P: prescribe aspi| for A',
            '// medication aspi|', 'medication Demo: doseForm "aspi|"']) {
            const mock = vi.fn(async () => response());
            const result = await complete(source, mock);
            expect(result.item).toBeUndefined();
            expect(mock).not.toHaveBeenCalled();
        }
    });

    test('offline search retains existing grammar completion', async () => {
        const result = await complete('medication De|', async () => { throw Error('offline'); });
        expect(result.item).toBeUndefined();
        result.provider.configureRxNorm({ ...options, enabled: false });
        const baseline = await result.provider.getCompletion(result.document, { textDocument: { uri: result.document.uri.toString() },
            position: result.document.textDocument.positionAt(result.offset) });
        expect(result.result?.items).toEqual(baseline?.items);
        expect(result.result?.isIncomplete).toBe(true);
    });
});
