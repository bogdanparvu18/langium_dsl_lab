import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const realRequire = createRequire(import.meta.url);

const bundle = (await build({entryPoints: ['packages/extension/src/extension/context-help.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode']})).outputFiles[0].text;
async function help(text, choice, stale = false, cursorOffset = text.length) {
  let handler, message; const commands = [];
  const lines = text.split('\n');
  const before = text.slice(0, cursorOffset).split('\n');
  const position = {line: before.length - 1, character: before.at(-1).length, isEqual: p => p === position};
  const document = {languageId: 'clinical-dsl', version: 1, lineAt: line => ({text: lines[line]}), getText: () => text, offsetAt: () => cursorOffset};
  const editor = {document, selection: {active: position}};
  const vscode = {window: {activeTextEditor: editor, showInformationMessage: async m => {message = m; if (stale) document.version++; return choice;}}, commands: {registerCommand: (id, h) => {handler = h; return {dispose(){}};}, executeCommand: async c => commands.push(c)}};
  const module = {exports: {}};
  vm.runInNewContext(bundle, {module, exports: module.exports, require: name => name === 'vscode' ? vscode : realRequire(name), console, setTimeout, clearTimeout, URL, process, TextEncoder, TextDecoder});
  module.exports.registerContextHelp({subscriptions: []});
  await handler();
  return {message, commands};
}

test('medication help reports missing fields and gives concrete contextual examples in any order', async () => {
  const missing = (await help('mEdIcAtIoN DemoMed: FREQUENCY bid, DOSE 10Mg, ')).message;
  assert.match(missing, /Missing or incomplete: route\./);
  assert.match(missing, /route PO/);
  const route = (await help('medication DemoMed: frequency BID, dose 10mg, route ')).message;
  assert.match(route, /route PO/);
  assert.match(route, /Missing or incomplete: route\./);
  const complete = (await help('Medication DemoMed: ROUTE po, frequency BID, 10 mg')).message;
  assert.match(complete, /Required medication fields are present/);
  assert.match((await help('Medication DemoMed: ROUTE po 10mg frequency BID')).message, /Required medication fields are present/);
});

test('product help identifies a missing paired qualifier and gives concrete examples', async () => {
  assert.match((await help('Medication DemoMed: dose 10mg, route PO, frequency BID, strength 325mg, ')).message, /doseForm \(required with strength\)/);
  assert.match((await help('Medication DemoMed: doseForm ')).message, /doseForm Oral Tablet/);
  assert.match((await help('Medication DemoMed: strength ')).message, /strength 325mg/);
});

test('help finds the start of a colon declaration across multiple lines', async () => {
  const result = await help('Medication DemoMed: dose 10mg,\n  frequency BID,\n  route ');
  assert.match(result.message, /Missing or incomplete: route\./);
  assert.match(result.message, /route PO/);
});

test('plan help reports missing references and supports either field order', async () => {
  const plan = (await help('pLaN DemoPlan: prescribe DemoMed, ')).message;
  assert.match(plan, /Missing or incomplete: for PATIENT/);
  assert.match(plan, /for DemoPatient/);
  assert.match((await help('Plan DemoPlan: prescribe DemoMed, for DemoPatient')).message, /Required plan fields are present/);
  assert.match((await help('Plan DemoPlan: prescribe DemoMed for DemoPatient')).message, /Required plan fields are present/);
  assert.match((await help('Plan DemoPlan: for DemoPatient, prescribe ')).message, /prescribe DemoMed/);
});

test('patient help remains unchanged and suggestion command ignores stale editor context', async () => {
  assert.equal((await help('Patient Jane: ')).message, 'Patient NAME: age NUMBER, condition IDENTIFIER');
  assert.deepEqual((await help('Medication ', 'Show suggestions')).commands, ['editor.action.triggerSuggest']);
  assert.deepEqual((await help('Medication ', 'Show suggestions', true)).commands, []);
});

test('question-mark binding is scoped to editable clinical documents', async () => {
  const manifest = JSON.parse(await readFile('packages/extension/package.json', 'utf8'));
  const binding = manifest.contributes.keybindings.find(x => x.command === 'clinical-dsl.contextHelp');
  assert.equal(binding.key, 'shift+/');
  assert.match(binding.when, /editorLangId == clinical-dsl/);
  assert.match(binding.when, /!editorReadonly/);
});

test('help ignores field-like words in line and block comments', async () => {
  for (const comment of ['// route PO frequency BID', '/* route PO frequency BID */']) {
    const message = (await help('Medication DemoMed: dose 10mg ' + comment)).message;
    assert.match(message, /Missing or incomplete: route, frequency/);
    assert.doesNotMatch(message, /Required medication fields are present/);
  }
  const message = (await help('Medication DemoMed: dose 10mg /* route IV */ route PO, frequency BID')).message;
  assert.match(message, /Required medication fields are present/);
});

test('help uses fields after the cursor and on later continuation lines', async () => {
  for (const source of [
    'Medication DemoMed: dose 10mg, route PO, frequency BID',
    'Medication DemoMed: dose 10mg,\n route PO,\n frequency BID'
  ]) {
    const result = await help(source, undefined, false, source.indexOf('10mg') + 4);
    assert.match(result.message, /Required medication fields are present/);
    assert.match(result.message, /Administered dose example/);
    assert.doesNotMatch(result.message, /Missing or incomplete/);
  }
});

test('help limits completeness to the enclosing declaration', async () => {
  const source = 'Medication First: dose 10mg\nMedication Second: dose 20mg route PO frequency BID';
  const result = await help(source, undefined, false, source.indexOf('10mg') + 4);
  assert.match(result.message, /Missing or incomplete: route, frequency/);
});

test('quoted product forms do not contribute medication fields or fake declarations', async () => {
  const source = 'Medication DemoMed: dose 10mg, strength 325mg, doseForm "route PO frequency BID Medication Other:"';
  const result = await help(source);
  assert.match(result.message, /Missing or incomplete: route, frequency/);
  assert.match(result.message, /Dose form example/);
});

test('plan examples use declared names and count references after the cursor', async () => {
  const source = 'Patient Alice: age 45, condition Fever\nMedication Aspirin: 10mg route PO frequency BID\nPlan P: prescribe Aspirin, for Alice';
  const result = await help(source, undefined, false, source.indexOf('prescribe Aspirin') + 'prescribe '.length);
  assert.match(result.message, /Required plan fields are present/);
  assert.match(result.message, /prescribe Aspirin/);
  assert.doesNotMatch(result.message, /DemoMed|DemoPatient|Missing or incomplete/);
});

test('commented declarations do not supply plan examples', async () => {
  const source = '// Patient Wrong: age 30, condition Fever\nPatient Alice: age 45, condition Fever\n/* Medication WrongMed: 10mg route PO frequency BID */\nMedication Aspirin: 10mg route PO frequency BID\nPlan P: for Alice';
  const result = await help(source);
  assert.match(result.message, /prescribe MEDICATION/);
  assert.doesNotMatch(result.message, /Wrong|WrongMed/);
  assert.match(result.message, /To complete, for example: prescribe Aspirin/);
});

test('help tolerates incomplete declarations without leaking parser exceptions', async () => {
  for (const source of ['Medication', 'Medication DemoMed:', 'Medication DemoMed: route', 'Plan', 'Plan P:', 'Plan P: prescribe']) {
    const result = await help(source);
    assert.equal(typeof result.message, 'string');
    assert.notEqual(result.message.length, 0);
  }
});
