import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createClinicalDslServices } from '../src/clinical-dsl-module.js';
import type { Model } from '../src/generated/ast.js';

async function read(text: string) {
    const services = createClinicalDslServices(EmptyFileSystem);
    return parseHelper<Model>(services.ClinicalDsl)(text, { validation: true });
}

function expectValid(doc: Awaited<ReturnType<typeof read>>) {
    expect(doc.parseResult.lexerErrors).toEqual([]);
    expect(doc.parseResult.parserErrors).toEqual([]);
    expect(doc.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
}

describe('keyword tokens used in names and text values', () => {
    test.each(['Dose', 'Route', 'Po', 'PRn', 'Mg'])('preserves a formerly valid Patient name: %s', async name => {
        const doc = await read(`Patient ${name}: age 45, condition Dose
Medication DemoMed: dose 10mg, route PO, frequency BID
Plan DemoPlan: for ${name}, prescribe DemoMed
show DemoPlan`);
        expectValid(doc);
        const model = doc.parseResult.value;
        expect(model.patient[0].name).toBe(name);
        expect(model.patient[0].condition).toBe('Dose');
        expect(model.plan[0].patient.ref).toBe(model.patient[0]);
    });

    test('keeps keyword-looking medication and plan names distinct from enum values', async () => {
        const doc = await read(`Patient Po: age 45, condition Dose
Medication Mg: dose 10MG, route po, frequency bid
Plan Route: for pO, prescribe mG
show rOuTe`);
        expectValid(doc);
        const model = doc.parseResult.value;
        expect(model.medication[0].name).toBe('Mg');
        expect(model.medication[0].unit).toBe('mg');
        expect(model.plan[0].name).toBe('Route');
        expect(model.display[0].plan.ref).toBe(model.plan[0]);
    });

    test.each([
        'dose 10mg, strength 325mg, doseForm Metered Dose Inhaler, route PO, frequency BID',
        'doseForm Metered Dose Inhaler dose 10mg route po frequency bid strength 325mg',
        'doseForm Oral Tablet dose 10mg route po frequency bid strength 325mg',
    ])('does not mistake a Dose word for a numeric dose field: %s', async fields => {
        const doc = await read(`Medication DemoMed: ${fields}`);
        expectValid(doc);
        const medication = doc.parseResult.value.medication[0];
        expect(medication.amount).toBe(10);
        expect(medication.doseForm).toBe(fields.includes('Metered') ? 'Metered Dose Inhaler' : 'Oral Tablet');
    });

    test.each(['"Metered Dose Inhaler"', "'Metered Dose Inhaler'", '"Dose"', '"Route Frequency DoseForm"'])('accepts explicitly bounded form text: %s', async form => {
        const doc = await read(`Medication DemoMed: doseForm ${form}, dose 10mg, route PO, frequency BID, strength "160MG / 5ML"`);
        expectValid(doc);
        const medication = doc.parseResult.value.medication[0];
        expect(medication.productStrength).toBe('160 mg/5 ml');
        expect(medication.doseForm).toBe(form.slice(1, -1));
    });

    test('keeps comment-like text inside quotes as literal text', async () => {
        const doc = await read('Medication DemoMed: dose 10mg, strength 325mg, doseForm "Oral // literal /* text */", route PO, frequency BID');
        expectValid(doc);
        expect(doc.parseResult.value.medication[0].doseForm).toBe('Oral // literal /* text */');
    });

    test('still reports duplicated form fields, including after a quoted value', async () => {
        const doc = await read('Medication DemoMed: dose 10mg, strength 325mg, doseForm "Metered Dose Inhaler" doseForm Oral Tablet, route PO, frequency BID');
        expect(doc.parseResult.lexerErrors).toEqual([]);
        expect(doc.parseResult.parserErrors).toEqual([]);
        expect(doc.diagnostics?.some(diagnostic => /Duplicate doseForm/.test(String(diagnostic.message)))).toBe(true);
    });

    test.each([
        'PATIENT Andrei: age 45, condition Fever',
        'Patient Andrei: AGE 45, condition Fever',
        'Patient Andrei: condition Fever, age 45',
    ])('does not relax Patient declaration keywords or field order: %s', async text => {
        const doc = await read(text);
        expect(doc.parseResult.parserErrors.length + doc.parseResult.lexerErrors.length).toBeGreaterThan(0);
    });

    test.each(['Medication DemoMed: dose', 'Medication DemoMed: doseForm Metered Dose', 'Medication DemoMed: doseForm "Metered Dose'])('recovers incomplete text without a validator exception: %s', async text => {
        const doc = await read(text);
        expect(doc.diagnostics?.filter(diagnostic => /error occurred during validation/i.test(String(diagnostic.message)))).toEqual([]);
    });
});
