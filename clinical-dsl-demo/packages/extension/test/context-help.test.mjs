import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const bundle = (await build({entryPoints: ['packages/extension/src/extension/context-help.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode']})).outputFiles[0].text;
async function help(text, choice, stale = false) {
  let handler, message; const commands = [];
  const lines = text.split('\n');
  const position = {line: lines.length - 1, character: lines.at(-1).length, isEqual: p => p === position};
  const document = {languageId: 'clinical-dsl', version: 1, lineAt: line => ({text: lines[line]})};
  const editor = {document, selection: {active: position}};
  const vscode = {window: {activeTextEditor: editor, showInformationMessage: async m => {message = m; if (stale) document.version++; return choice;}}, commands: {registerCommand: (id, h) => {handler = h; return {dispose(){}};}, executeCommand: async c => commands.push(c)}};
  const module = {exports: {}};
  vm.runInNewContext(bundle, {module, exports: module.exports, require: () => vscode});
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
