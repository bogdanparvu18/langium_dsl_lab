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
    test.each([
        ['aspi|', 'Medication Aspirin:'],
        ['Medication MorningMedication: aspi|', 'Medication MorningMedication:']
    ])('accepting a bare prefix in %s writes the exact catalog name and ID', async (draft, declaration) => {
        const result = await complete(draft);
        expect(result.item).toBeDefined();
        const text = apply(result.item!, result.document);
        expect(text).toBe(`${declaration} product "Aspirin fixture product" rxcui "900001"`);
    });

    test('a standalone prefix between declarations creates a collision-free medication and replaces the full word', async () => {
        const prefix = 'Medication ASPIRIN: dose 1mg route PO frequency QD\nPatient Alice: age 45, condition Fever\n';
        const suffix = '\nPlan MorningPlan: for Alice prescribe Aspirin_900001';
        const result = await complete(prefix + 'aspi|rin' + suffix);
        expect(result.item).toBeDefined();
        const changed = apply(result.item!, result.document);
        expect(changed).toBe(prefix + 'Medication Aspirin_900001: product "Aspirin fixture product" rxcui "900001"' + suffix);
    });

    test('bare lookup can select a mixed-case prefix after a completed administration field', async () => {
        const met = { ...product, display: 'Metformin fixture tablet', rxcui: '900003' };
        const result = await complete('Medication MorningMedication: dose 20mg, mEtF|ormin route IV frequency PRN',
            async () => response('metf', { items: [met] }));
        expect(result.item?.label).toBe(met.display);
        const changed = apply(result.item!, result.document);
        const parsed = await parseHelper<Model>(result.services.ClinicalDsl)(changed);
        expect(parsed.parseResult.parserErrors).toEqual([]);
        expect(parsed.parseResult.value.medication).toHaveLength(1);
        expect(parsed.parseResult.value.medication[0]).toMatchObject({
            name: 'MorningMedication', productName: met.display, rxcui: met.rxcui, amount: 20, unit: 'mg', route: 'IV', frequency: 'PRN'
        });
    });

    test('an indented prefix after the medication colon belongs to the existing alias', async () => {
        const result = await complete('Medication Morning:\n  aspi|');
        expect(result.item).toBeDefined();
        const parsed = await parseHelper<Model>(result.services.ClinicalDsl)(apply(result.item!, result.document));
        expect(parsed.parseResult.parserErrors).toEqual([]);
        expect(parsed.parseResult.value.medication).toHaveLength(1);
        expect(parsed.parseResult.value.medication[0]).toMatchObject({ name: 'Morning', productName: product.display, rxcui: product.rxcui });
    });

    test('searching in a quoted product label updates its paired RxCUI', async () => {
        const result = await complete('Medication Morning: product "aspi|rin" rxcui "900002"');
        expect(result.item).toBeDefined();
        const parsed = await parseHelper<Model>(result.services.ClinicalDsl)(apply(result.item!, result.document));
        expect(parsed.parseResult.parserErrors).toEqual([]);
        expect(parsed.parseResult.value.medication[0]).toMatchObject({ name: 'Morning', productName: product.display, rxcui: product.rxcui });
    });

    test('new prefix becomes readable alias plus durable exact binding', async () => {
        const result = await complete('medication aspi|');
        expect(result.item).toBeDefined();
        const text = apply(result.item!, result.document);
        expect(text).toBe('medication Aspirin: product "Aspirin fixture product" rxcui "900001"');
        const parsed = await parseHelper<Model>(result.services.ClinicalDsl)(text);
        expect(parsed.parseResult.parserErrors).toEqual([]);
        expect(parsed.parseResult.value.medication[0]).toMatchObject({ rxcui: product.rxcui, productName: product.display });
        expect(parsed.parseResult.value.medication[0].rxnormRelease).toBeUndefined();
        expect(parsed.parseResult.value.medication[0].amount).toBeUndefined();
    });

    test('selecting a product preserves existing alias, fields, order and Plan references', async () => {
        const result = await complete('medication aspi|: frequency BID dose 10mg route PO strength "10mg" doseForm "Oral Tablet"\nPlan P: for A prescribe aspi');
        const text = apply(result.item!, result.document);
        expect(text).toContain('medication aspi: product "Aspirin fixture product" rxcui "900001"');
        expect(text).toContain('frequency BID dose 10mg route PO strength "10mg" doseForm "Oral Tablet"');
        expect(text).toContain('prescribe aspi');
    });

    test('reselection replaces both binding values without duplicate fields', async () => {
        const result = await complete('medication aspi|: RXNORMRELEASE "2025-01-06" route po RXCUI "900002"');
        const text = apply(result.item!, result.document);
        expect(text).toBe('medication aspi: product "Aspirin fixture product" route po RXCUI "900001"');
    });

    test('typing a product prefix inside rxcui selects for an arbitrary existing alias', async () => {
        const result = await complete('medication MyMorningMed: route po rxcui "aspi|" dose 10mg frequency bid');
        const text = apply(result.item!, result.document);
        expect(text).toBe('medication MyMorningMed: route po product "Aspirin fixture product" rxcui "900001" dose 10mg frequency bid');
        expect(result.item!.textEdit).toMatchObject({ newText: '900001' });
    });

    test('accepting a quoted prefix fills an unfinished product field once', async () => {
        const result = await complete('Medication MorningMedication: product rxcui "aspi|"');
        const text = apply(result.item!, result.document);
        expect(text).toBe('Medication MorningMedication: product "Aspirin fixture product" rxcui "900001"');
        const parsed = await parseHelper<Model>(result.services.ClinicalDsl)(text);
        expect(parsed.parseResult.parserErrors).toEqual([]);
    });

    test('rxcui reselection preserves single quotes and migrates the old release field', async () => {
        const result = await complete("medication MyMorningMed: rxcui 'aspi|rin' rxnormRelease '2025-01-06'");
        const text = apply(result.item!, result.document);
        expect(text).toBe('medication MyMorningMed: rxcui \'900001\' product "Aspirin fixture product"');
        expect(text.match(/rxcui/g)).toHaveLength(1);
    });

    test('an incomplete binding label gets a value, not a duplicate label', async () => {
        const result = await complete('medication aspi|: rxcui');
        expect(apply(result.item!, result.document)).toBe('medication aspi: product "Aspirin fixture product" rxcui "900001"');
    });

    test('reselection updates the visible product, preserves comments and removes legacy release', async () => {
        const result = await complete('Medication MorningMedication: PRODUCT "Old", rxnormRelease /* provenance */ "2025-01-06",\n' +
            '  rxcui "aspi|", dose 10mg route PO frequency BID\nPlan P: prescribe MorningMedication for A');
        const text = apply(result.item!, result.document);
        expect(text).toContain('PRODUCT "Aspirin fixture product"');
        expect(text).toContain('/* provenance */');
        expect(text).toContain('rxcui "900001", dose 10mg route PO frequency BID');
        expect(text).toContain('prescribe MorningMedication');
        expect(text).not.toMatch(/rxnormRelease/i);
        const parsed = await parseHelper<Model>(result.services.ClinicalDsl)(text);
        expect(parsed.parseResult.parserErrors).toEqual([]);
        expect(parsed.parseResult.value.medication[0]).toMatchObject({ productName: product.display, rxcui: product.rxcui });
    });

    test('copies the chosen label exactly, including punctuation, whitespace and Unicode', async () => {
        const display = 'Aspirin "A" \\ B  /  [O\'Brien] µg';
        const result = await complete('Medication product: doseForm Oral Tablet rxcui "aspi|"',
            async () => response('aspi', { items: [{ ...product, display }] }));
        const text = apply(result.item!, result.document);
        const parsed = await parseHelper<Model>(result.services.ClinicalDsl)(text);
        expect(parsed.parseResult.parserErrors).toEqual([]);
        expect(parsed.parseResult.value.medication[0]).toMatchObject({ name: 'product', doseForm: 'Oral Tablet', productName: display, rxcui: product.rxcui });
    });

    test('a syntax suggestion never inserts the legacy release field', async () => {
        const result = await complete('medication Test: |');
        const labels = result.result?.items.map(item => item.label);
        expect(labels).toContain('product');
        expect(labels).not.toContain('rxnormRelease');
    });

    test('new alias avoids existing case-insensitive collisions', async () => {
        const result = await complete('medication ASPIRIN: dose 1mg route PO frequency QD\nmedication aspi|');
        expect(apply(result.item!, result.document)).toContain('medication Aspirin_900001:');
    });

    test('another incomplete Medication does not break alias collision checks', async () => {
        const result = await complete('medication :\nmedication aspi|');
        expect(result.item).toBeDefined();
        expect(apply(result.item!, result.document)).toContain('medication Aspirin: product "Aspirin fixture product" rxcui "900001"');
    });

    test('does not query from patient names, plan references, comments or values', async () => {
        for (const source of ['Patient aspi|: age 1, condition Fever', 'Plan P: prescribe aspi| for A',
            'Patient P: age 45, condition aspi|', 'show aspi|', '// medication aspi|',
            'Medication Morning: /* aspi| */', 'medication Demo: doseForm "aspi|"',
            'Medication Demo: doseForm Oral aspi|', 'Medication Demo: route aspi|',
            'Medication Demo: frequency aspi|', 'Medication Demo: dose aspi|', 'Medication Demo: strength "aspi|"',
            'Medication Demo: route\naspi|', 'Plan P: prescribe\naspi|']) {
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
