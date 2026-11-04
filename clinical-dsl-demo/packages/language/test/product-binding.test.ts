import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createClinicalDslServices } from '../src/clinical-dsl-module.js';
import type { Model } from '../src/generated/ast.js';

// These numeric identifiers are synthetic fixtures, not claims about RxNorm products.
async function read(text: string) {
    const services = createClinicalDslServices(EmptyFileSystem);
    return parseHelper<Model>(services.ClinicalDsl)(text, { validation: true });
}
const required = 'dose 10mg route PO frequency BID';
function errors(doc: Awaited<ReturnType<typeof read>>) {
    return doc.diagnostics?.filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message) ?? [];
}

describe('explicit RxNorm product identity', () => {
    test.each([
        `rxcui "900001" rxnormRelease "2026-10-05" ${required}`,
        `FREQUENCY bid RXNORMRELEASE "2026-10-05" dose 10 MG RxCuI "900001" ROUTE po`,
        `route PO, rxcui '900001', dose 10mg, frequency BID, rxnormRelease '2026-10-05'`
    ])('accepts mixed casing and any binding field order: %s', async fields => {
        const doc = await read(`Medication MyChosenProduct: ${fields}`);
        expect(doc.parseResult.lexerErrors).toEqual([]);
        expect(doc.parseResult.parserErrors).toEqual([]);
        expect(errors(doc)).toEqual([]);
        expect(doc.parseResult.value.medication[0]).toMatchObject({
            name: 'MyChosenProduct', amount: 10, unit: 'mg', route: 'PO', frequency: 'BID',
            rxcui: '900001', rxnormRelease: '2026-10-05'
        });
    });

    test('keeps a selected product bound through its user-defined alias and Plan reference', async () => {
        const doc = await read(`Patient RxnormRelease: age 45, condition Rxcui
Medication Rxcui: ${required} rxcui "900001" rxnormRelease "2026-10-05"
Plan P: prescribe rxCui, for rxNormRelease
show P`);
        expect(errors(doc)).toEqual([]);
        expect(doc.parseResult.value.plan[0].medication.ref).toBe(doc.parseResult.value.medication[0]);
        expect(doc.parseResult.value.medication[0].name).toBe('Rxcui');
        expect(doc.parseResult.value.patient[0].name).toBe('RxnormRelease');
    });

    test.each([
        ['rxcui "900001"', /requires rxnormRelease/],
        ['rxnormRelease "2026-10-05"', /requires a selected product RxCUI/],
        ['rxcui "" rxnormRelease "2026-10-05"', /quoted positive digit string/],
        ['rxcui "0" rxnormRelease "2026-10-05"', /quoted positive digit string/],
        ['rxcui "00900001" rxnormRelease "2026-10-05"', /quoted positive digit string/],
        ['rxcui "abc" rxnormRelease "2026-10-05"', /quoted positive digit string/],
        ['rxcui "123456789012345678901" rxnormRelease "2026-10-05"', /at most 20 digits/],
        ['rxcui "900001" rxnormRelease "2026-02-30"', /valid YYYY-MM-DD/],
        ['rxcui "900001" rxnormRelease "2026-13-05"', /valid YYYY-MM-DD/],
        ['rxcui "900001" rxnormRelease "0000-10-05"', /valid YYYY-MM-DD/],
        ['rxcui "900001" rxnormRelease "October 5"', /valid YYYY-MM-DD/]
    ] as const)('rejects invalid or incomplete binding: %s', async (binding, message) => {
        const doc = await read(`Medication DemoMed: ${required} ${binding}`);
        expect(errors(doc).some(error => message.test(String(error)))).toBe(true);
    });

    test.each([
        ['rxcui "900001" rxcui "900002" rxnormRelease "2026-10-05"', /Duplicate rxcui/],
        ['rxnormRelease "2026-10-05" rxcui "900001" RXNORMRELEASE "2026-11-02"', /Duplicate rxnormRelease/]
    ] as const)('rejects a repeated binding field: %s', async (binding, message) => {
        const doc = await read(`Medication DemoMed: ${required} ${binding}`);
        expect(errors(doc).some(error => message.test(String(error)))).toBe(true);
    });

    test('retains RxCUI as an exact string beyond JavaScript numeric precision', async () => {
        const doc = await read(`Medication DemoMed: ${required} rxcui "9007199254740993" rxnormRelease "2024-02-29"`);
        expect(errors(doc)).toEqual([]);
        expect(doc.parseResult.value.medication[0].rxcui).toBe('9007199254740993');
    });

    test('keeps unbound declarations backward compatible', async () => {
        const doc = await read(`Medication DemoMed: ${required}`);
        expect(errors(doc)).toEqual([]);
        expect(doc.parseResult.value.medication[0].rxcui).toBeUndefined();
        expect(doc.parseResult.value.medication[0].rxnormRelease).toBeUndefined();
    });
});
