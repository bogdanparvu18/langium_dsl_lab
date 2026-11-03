import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createClinicalDslServices } from '../src/clinical-dsl-module.js';
import type { Model } from '../src/generated/ast.js';

async function read(input: string) {
    // Each test gets its own workspace index to prevent earlier fixtures from
    // providing unintended cross-reference targets.
    const services = createClinicalDslServices(EmptyFileSystem);
    const parse = parseHelper<Model>(services.ClinicalDsl);
    return parse(input, { validation: true });
}

function errors(doc: Awaited<ReturnType<typeof read>>) {
    const result = doc.diagnostics?.filter(diagnostic => diagnostic.severity === 1) ?? [];
    // A validator exception is not evidence that malformed data was rejected.
    expect(result.filter(diagnostic => /error occurred during validation/i.test(String(diagnostic.message)))).toEqual([]);
    return result;
}

function expectValid(doc: Awaited<ReturnType<typeof read>>) {
    expect(doc.parseResult.lexerErrors).toEqual([]);
    expect(doc.parseResult.parserErrors).toEqual([]);
    expect(errors(doc)).toEqual([]);
}

describe('flexible colon Medication and Plan syntax', () => {
    test.each([
        'dose 10 mg, route PO, frequency BID',
        'frequency bid, dose 10mg, route po',
        'RoUtE pO, FrEqUeNcY bId, DoSe 10MG',
        'frequency BID route PO dose 10 mg',
        // Existing colon syntax remains valid without a dose label.
        '10 mg, route PO, frequency BID',
        'frequency BiD, 10mG, route Po',
    ])('normalizes variants and links plan references: %s', async medicationFields => {
        const doc = await read(`Patient Andrei: age 45, condition Fever
mEdIcAtIoN DemoMed: ${medicationFields}
pLaN DemoPlan: PrEsCrIbE demomed, FoR andrei
show demoplan`);
        expectValid(doc);
        const model = doc.parseResult.value;
        const medication = model.medication[0];
        expect(medication.amount).toBe(10);
        expect(medication.unit).toBe('mg');
        expect(medication.route).toBe('PO');
        expect(medication.frequency).toBe('BID');
        expect(model.plan[0].patient.ref).toBe(model.patient[0]);
        expect(model.plan[0].medication.ref).toBe(medication);
        expect(model.display[0].plan.ref).toBe(model.plan[0]);
    });

    test('preserves Patient colon syntax and the original plan order', async () => {
        const doc = await read(`Patient Andrei: age 45, condition Fever
Medication DemoMed: dose 2.5ml, route IV, frequency Q4H
Plan DemoPlan: for Andrei, prescribe DemoMed
show DemoPlan`);
        expectValid(doc);
        expect(doc.parseResult.value.patient[0]).toMatchObject({ name: 'Andrei', age: 45, condition: 'Fever' });
        expect(doc.parseResult.value.medication[0]).toMatchObject({ amount: 2.5, unit: 'ml', route: 'IV', frequency: 'Q4H' });
    });

    test('retains product strength and dose form while allowing them in different positions', async () => {
        const doc = await read(`Patient Andrei: age 45, condition Fever
Medication DemoMed: doseForm Oral Tablet, route po, strength 325mg, frequency prn, dose 15mg
Plan DemoPlan: for Andrei, prescribe DemoMed
show DemoPlan`);
        expectValid(doc);
        expect(doc.parseResult.value.medication[0]).toMatchObject({
            amount: 15,
            unit: 'mg',
            route: 'PO',
            frequency: 'PRN',
            doseForm: 'Oral Tablet'
        });
        expect(doc.parseResult.value.medication[0].productStrength).toBe('325 mg');
    });

    test.each(['160MG/5ML', '160 mg / 5 ml'])('normalizes equivalent strengths: %s', async strength => {
        const doc = await read(`Medication DemoMed: dose 15mg, strength ${strength}, doseForm Oral Tablet, route PO, frequency PRN`);
        expectValid(doc);
        expect(doc.parseResult.value.medication[0].productStrength).toBe('160 mg/5 ml');
    });

    test.each([
        'dose 0 mg, route PO, frequency BID',
        'dose 10 mg, route PO',
        'dose 10 mg, frequency BID',
        'dose 10 mg, route PO, frequency BID, strength 325 mg',
        'dose 10 mg, dose 20 mg, route PO, frequency BID',
        'dose 10 mg, route PO, route IV, frequency BID',
        'dose 10 mg, route UNKNOWN, frequency BID',
        'dose 10 mysteryUnits, route PO, frequency BID',
    ])('rejects incomplete, invalid, or duplicate medication values: %s', async medicationFields => {
        const doc = await read(`Medication DemoMed: ${medicationFields}`);
        expect(errors(doc).length).toBeGreaterThan(0);
    });

    test.each([
        'for Andrei, prescribe DemoMed, prescribe OtherMed',
        'for Andrei, for OtherPatient, prescribe DemoMed',
    ])('rejects duplicate plan fields rather than selecting a value: %s', async planFields => {
        const doc = await read(`Patient Andrei: age 45, condition Fever
Patient OtherPatient: age 30, condition Fever
Medication DemoMed: 10 mg, route PO, frequency BID
Medication OtherMed: 10 mg, route PO, frequency BID
Plan DemoPlan: ${planFields}`);
        expect(errors(doc).length).toBeGreaterThan(0);
    });

    test('does not silently link a missing medication', async () => {
        const doc = await read(`Patient Andrei: age 45, condition Fever
Plan DemoPlan: for Andrei, prescribe MissingMed
show DemoPlan`);
        expect(errors(doc).length).toBeGreaterThan(0);
    });

    test.each([
        `Medication DemoMed: 10 mg, route PO, frequency BID
Medication demomed: 20 mg, route IV, frequency PRN`,
        `Medication DemoMed: 10 mg, route PO, frequency BID
Plan DemoPlan: for Andrei, prescribe DemoMed
Plan demoplan: for Andrei, prescribe DemoMed
show DEMOPLAN`,
    ])('rejects names that collide ignoring case', async declarations => {
        const doc = await read(`Patient Andrei: age 45, condition Fever
${declarations}`);
        expect(doc.parseResult.lexerErrors).toEqual([]);
        expect(doc.parseResult.parserErrors).toEqual([]);
        expect(errors(doc).some(error => /duplicate|ambiguous|already|conflict/i.test(String(error.message)))).toBe(true);
    });

    test('does not silently link a patient when case-insensitive references are ambiguous', async () => {
        const doc = await read(`Patient Andrei: age 45, condition Fever
Patient andrei: age 30, condition Fever
Medication DemoMed: 10 mg, route PO, frequency BID
Plan DemoPlan: for ANDREI, prescribe DemoMed`);
        expect(doc.parseResult.lexerErrors).toEqual([]);
        expect(doc.parseResult.parserErrors).toEqual([]);
        expect(errors(doc).length).toBeGreaterThan(0);
    });

    test('rejects duplicate show statements targeting the same plan with different case', async () => {
        const doc = await read(`Patient Andrei: age 45, condition Fever
Medication DemoMed: 10 mg, route PO, frequency BID
Plan DemoPlan: for Andrei, prescribe DemoMed
show DemoPlan
show demoplan`);
        expect(doc.parseResult.lexerErrors).toEqual([]);
        expect(doc.parseResult.parserErrors).toEqual([]);
        expect(errors(doc).some(error => /duplicate|already|more than once/i.test(String(error.message)))).toBe(true);
    });
});
