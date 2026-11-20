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
    test('preserves the exact decimal dose sent for bound-product validation', async () => {
        const order = (amount: string) =>
            `Medication Alias: product "Demo tablet" rxcui "900001" dose ${amount}mg route PO frequency BID`;
        for (const amount of ['0.1', '001.000', '1000.00000000000000', '0.00000001', '1000000000000000000000']) {
            expect(errors(await read(order(amount)))).toEqual([]);
        }
        for (const amount of ['1000.00000000000001', '499.999999999999999', '9007199254740993']) {
            const doc = await read(order(amount));
            const diagnostic = doc.diagnostics?.find(d => d.code === 'monograph-dose-precision');
            expect(diagnostic?.severity).toBe(1);
            expect(doc.textDocument.getText(diagnostic!.range)).toBe(amount);
        }
    });

    test.each([
        `product "Demo tablet" rxcui "900001" ${required}`,
        `frequency bid RxCuI '900001', dose 10 MG, PrOdUcT 'Demo tablet' ROUTE po`,
        `rxcui "900001" ${required} PRODUCT "Demo tablet" rxnormRelease "2026-10-05"`
    ])('binds the visible name and exact RxCUI: %s', async fields => {
        const doc = await read(`Medication MorningMedication: ${fields}`);
        expect(errors(doc)).toEqual([]);
        expect(doc.parseResult.value.medication[0]).toMatchObject({
            name: 'MorningMedication', productName: 'Demo tablet', rxcui: '900001'
        });
    });

    test('preserves spelling, punctuation, whitespace and escapes in the returned display', async () => {
        const display = 'Démø  "A" \\ B /* name */ // 2.5 MG/mL [Brand]';
        const doc = await read(`Medication Alias: product ${JSON.stringify(display)} rxcui "900001" ${required}`);
        expect(errors(doc)).toEqual([]);
        expect(doc.parseResult.value.medication[0].productName).toBe(display);
        expect(doc.parseResult.value.medication[0].rxnormRelease).toBeUndefined();
    });

    test.each(['Oral Tablet', 'Demo Product Spray', 'Demo Product'])(
        'distinguishes the unquoted dose form %s from the next product field', async form => {
            const doc = await read(`Medication Alias: strength 5mg doseForm ${form} product "Demo tablet" rxcui "900001" ${required}`);
            expect(errors(doc)).toEqual([]);
            expect(doc.parseResult.value.medication[0]).toMatchObject({ doseForm: form, productName: 'Demo tablet' });
        }
    );

    test('ignores comments between a product keyword and its quoted value', async () => {
        const doc = await read(`Medication Alias: strength 5mg doseForm Demo Product /* form word */ Spray
            product /* "ignored" */ // 'ignored'
            "Demo tablet" rxcui "900001" ${required}`);
        expect(errors(doc)).toEqual([]);
        expect(doc.parseResult.value.medication[0]).toMatchObject({ doseForm: 'Demo Product Spray', productName: 'Demo tablet' });
    });

    test('preserves Product as a declaration name, patient condition and Plan reference', async () => {
        const doc = await read(`Patient Product: age 45, condition PrOdUct
Medication MorningMedication: ${required} product "Demo tablet" rxcui "900001"
Plan P: prescribe MorningMedication for Product`);
        expect(errors(doc)).toEqual([]);
        expect(doc.parseResult.value.patient[0]).toMatchObject({ name: 'Product', condition: 'PrOdUct' });
        expect(doc.parseResult.value.plan[0].medication.ref).toBe(doc.parseResult.value.medication[0]);
        expect(doc.parseResult.value.plan[0].patient.ref).toBe(doc.parseResult.value.patient[0]);
    });

    test.each([
        `rxcui "900001" rxnormRelease "2026-10-05" ${required}`,
        `FREQUENCY bid RXNORMRELEASE "2026-10-05" dose 10 MG RxCuI "900001" ROUTE po`,
        `route PO, rxcui '900001', dose 10mg, frequency BID, rxnormRelease '2026-10-05'`
    ])('reads legacy release-pinned bindings in any order: %s', async fields => {
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
        ['rxcui "900001"', /requires a product name/],
        ['rxnormRelease "2026-10-05"', /supply its RxCUI/],
        ['product "Demo tablet"', /supply its RxCUI/],
        ['product "   " rxcui "900001"', /name cannot be blank/],
        ['product "Demo tablet" rxcui "aspi"', /quoted positive digit string/],
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
        ['product "Demo tablet" rxcui "900001" PRODUCT "Another product"', /Duplicate product/],
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
