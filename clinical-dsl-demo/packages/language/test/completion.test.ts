import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createClinicalDslServices } from '../src/clinical-dsl-module.js';
import type { Model } from '../src/generated/ast.js';

async function labels(sourceWithCursor: string) {
    const offset = sourceWithCursor.indexOf('|');
    expect(offset).toBeGreaterThanOrEqual(0);
    const source = sourceWithCursor.slice(0, offset) + sourceWithCursor.slice(offset + 1);
    const services = createClinicalDslServices(EmptyFileSystem);
    const document = await parseHelper<Model>(services.ClinicalDsl)(source, { validation: true });
    const result = await services.ClinicalDsl.lsp.CompletionProvider!.getCompletion(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset)
    });
    return result?.items.map(item => item.label) ?? [];
}

describe('completion respects existing fields', () => {
    test('does not offer a second dose, route or frequency after a complete medication', async () => {
        const result = await labels('Medication DemoMed: dose 10mg, route PO, frequency BID, |');
        expect(result).not.toContain('dose');
        expect(result).not.toContain('route');
        expect(result).not.toContain('frequency');
        expect(result).not.toContain('10');
        expect(result).toContain('strength');
        expect(result).toContain('doseForm');
    });

    test('also filters fields on the right side of the cursor', async () => {
        const result = await labels('Medication DemoMed: | dose 10mg, route PO, frequency BID');
        expect(result).not.toContain('dose');
        expect(result).not.toContain('route');
        expect(result).not.toContain('frequency');
        expect(result).not.toContain('10');
    });

    test('allows replacing route and amount values', async () => {
        expect(await labels('Medication DemoMed: dose 10mg, route P|O, frequency BID')).toContain('PO');
        expect(await labels('Medication DemoMed: dose 1|0 mg, route PO, frequency BID')).toContain('10');
    });

    test('allows editing an existing field keyword', async () => {
        expect(await labels('Medication DemoMed: dose 10mg, ro|ute PO, frequency BID')).toContain('route');
    });

    test('offers the remaining plan field when its keyword is partially typed', async () => {
        const result = await labels('Patient Alice: age 45, condition Fever\nPlan P: for Alice, pr|');
        expect(result).toContain('prescribe');
    });

    test('does not treat comments as fields', async () => {
        const result = await labels('Medication DemoMed: dose 10mg, /* route PO */ |');
        expect(result).toContain('route');
        expect(result).toContain('frequency');
    });

    test('only offers the remaining plan field', async () => {
        const result = await labels('Patient Alice: age 45, condition Fever\nMedication DemoMed: 10mg route PO frequency BID\nPlan P: for Alice, |');
        expect(result).toContain('prescribe');
        expect(result).not.toContain('for');
    });

    test('does not supplement Plan completions inside comments', async () => {
        const prefix = 'Patient Alice: age 45, condition Fever\nPlan P: for Alice, ';
        expect(await labels(prefix + '// |')).not.toContain('prescribe');
        expect(await labels(prefix + '/* | */')).not.toContain('prescribe');
        expect(await labels(prefix + '// pr|')).not.toContain('prescribe');
        expect(await labels(prefix + '"pr|"')).not.toContain('prescribe');
    });

    test('keeps reference completion when editing an existing plan', async () => {
        const result = await labels('Patient Alice: age 45, condition Fever\nMedication DemoMed: 10mg route PO frequency BID\nPlan P: for Alice, prescribe Demo|Med');
        expect(result).toContain('DemoMed');
    });
});
