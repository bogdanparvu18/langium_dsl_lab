import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { createClinicalDslServices } from '../src/clinical-dsl-module.js';
import type { Model } from '../src/generated/ast.js';

const services = createClinicalDslServices(EmptyFileSystem);
const parse = parseHelper<Model>(services.ClinicalDsl);
const fixture = `Patient DemoPatient: age 30, condition DemoCondition
Medication aspirin: 15 mg, strength 325 mg, doseForm Oral Tablet, route PO, frequency PRN
Plan DemoPlan: for DemoPatient, prescribe aspirin
show DemoPlan`;
async function read(text: string) { return parse(text, { validation: true }); }
function errors(d: Awaited<ReturnType<typeof read>>) { return d.diagnostics?.filter(x => x.severity === 1) ?? []; }

describe('Colon DSL', () => {
    test('links declarations and preserves unquoted attributes', async () => {
        const d = await read(fixture);
        expect(d.parseResult.lexerErrors).toHaveLength(0);
        expect(d.parseResult.parserErrors).toHaveLength(0);
        expect(errors(d)).toHaveLength(0);
        const m = d.parseResult.value.medication[0];
        expect(m.amount).toBe(15);
        expect(m.productStrength).toBe('325 mg');
        expect(m.doseForm).toBe('Oral Tablet');
        expect(d.parseResult.value.plan[0].medication.ref).toBe(m);
    });
    test('accepts concentrations and multiple declarations', async () => {
        const d = await read(fixture.replace('325 mg', '160 mg/5 ml') + '\nMedication second: 2.5 ml, route PO, frequency QD');
        expect(errors(d)).toHaveLength(0);
        expect(d.parseResult.value.medication).toHaveLength(2);
        expect(d.parseResult.value.medication[0].productStrength).toBe('160 mg/5 ml');
    });
    test('retains legacy syntax', async () => {
        expect(errors(await read('medication aspirin { 15 mg strength "325 mg" doseForm "Oral Tablet" route PO frequency PRN }'))).toHaveLength(0);
    });
    test('rejects missing fields, dangling qualifiers and zero dose', async () => {
        for (const text of [fixture.replace(', route PO', ''), fixture.replace(', doseForm Oral Tablet', ''), fixture.replace('15 mg', '0 mg'), fixture.replace('325 mg', '0 mg')]) {
            expect(errors(await read(text)).length).toBeGreaterThan(0);
        }
    });
    test('question marks are not part of the persisted language', async () => {
        const d = await read(fixture.replace('15 mg', '?'));
        expect(d.parseResult.lexerErrors.length + d.parseResult.parserErrors.length).toBeGreaterThan(0);
    });
});
