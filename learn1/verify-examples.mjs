import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServicesForGrammar } from 'langium/grammar';
import { parseHelper } from 'langium/test';
import { registerClinicChecks } from './validation.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const grammars = await Promise.all([
    read('01-patients.langium'),
    read('02-relations.langium'),
    read('03-pipeline.langium')
]);
async function parse(index, content, custom = false) {
    const services = await createServicesForGrammar({grammar: grammars[index]});
    if (custom) registerClinicChecks(services);
    return parseHelper(services)(content, {validation: true});
}
const syntaxOK = doc => !doc.parseResult.lexerErrors.length &&
    !doc.parseResult.parserErrors.length;
const errors = doc => (doc.diagnostics ?? []).filter(item => item.severity === 1);
const tests = [];
const test = (name, check) => tests.push([name, check]);

test('01 numeric age and two patients', async () => {
    const d = await parse(0, await read('01-patients.clinic'));
    assert(syntaxOK(d)); assert.equal(errors(d).length, 0);
    assert.equal(d.parseResult.value.patients.length, 2);
    assert.equal(d.parseResult.value.patients[0].age, 42);
});
test('01 plus requires at least one patient', async () => {
    assert(!syntaxOK(await parse(0, '')));
});
test('01 text cannot replace integer', async () => {
    assert(!syntaxOK(await parse(0, 'patient Ana age forty')));
});
test('01 integer alone does not constrain age', async () => {
    const d = await parse(0, 'patient Ana age 999');
    assert(syntaxOK(d)); assert.equal(errors(d).length, 0);
});
test('02 references arrays and flags', async () => {
    const d = await parse(1, await read('02-relations.clinic'));
    assert(syntaxOK(d)); assert.equal(errors(d).length, 0);
    const m = d.parseResult.value;
    assert.deepEqual(m.patients[0].symptoms, ['fatigue', 'nausea']);
    assert.equal(m.observations[0].patient.ref, m.patients[0]);
    assert.equal(m.observations[0].urgent, true);
    assert.equal(m.observations[1].urgent, false);
});
test('02 undefined patient is a linking problem', async () => {
    const d = await parse(1, 'patient Ana age 42\nobserve Maria severity mild');
    assert(syntaxOK(d));
    assert(errors(d).some(e => e.message.includes('Maria')));
});
test('02 invalid severity is a syntax problem', async () => {
    assert(!syntaxOK(await parse(1, 'patient Ana age 42\nobserve Ana severity extreme')));
});
test('02 custom validator rejects age 999', async () => {
    const d = await parse(1, 'patient Ana age 999', true);
    assert(syntaxOK(d));
    assert(errors(d).some(e => e.message.includes('130')));
});
test('02 custom validator rejects duplicate names', async () => {
    const d = await parse(1, 'patient Ana age 42\npatient Ana age 35', true);
    assert(errors(d).some(e => e.message.includes('duplicat')));
});
test('03 pipeline references and string conversion', async () => {
    const d = await parse(2, await read('03-pipeline.pipeline'));
    assert(syntaxOK(d)); assert.equal(errors(d).length, 0);
    const m = d.parseResult.value;
    assert.equal(m.datasets[0].path, 'frames.csv');
    assert.equal(m.runs[0].dataset.ref, m.datasets[0]);
    assert.equal(m.runs[0].model.ref, m.models[0]);
    assert.equal(m.runs[0].epochs, 5);
});
test('03 unknown dataset is rejected by linking', async () => {
    const d = await parse(2, 'model baseline type classifier\ntrain baseline on missing epochs 5');
    assert(syntaxOK(d));
    assert(errors(d).some(e => e.message.includes('missing')));
});

for (const [name, check] of tests) {
    await check();
    console.log('PASS ' + name);
}
console.log(`${tests.length} checks passed with Langium 4.4.0.`);
