import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const bundle = (await build({entryPoints: ['packages/extension/src/extension/context-help.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode']})).outputFiles[0].text;
async function help(text, choice, stale = false) {
  let handler, message; const commands = [];
  const position = {line: 0, character: text.length, isEqual: p => p === position};
  const document = {languageId: 'clinical-dsl', version: 1, lineAt: () => ({text})};
  const editor = {document, selection: {active: position}};
  const vscode = {window: {activeTextEditor: editor, showInformationMessage: async m => {message = m; if (stale) document.version++; return choice;}}, commands: {registerCommand: (id, h) => {handler = h; return {dispose(){}};}, executeCommand: async c => commands.push(c)}};
  const module = {exports: {}};
  vm.runInNewContext(bundle, {module, exports: module.exports, require: () => vscode});
  module.exports.registerContextHelp({subscriptions: []});
  await handler();
  return {message, commands};
}
test('context help explains dose, strength, form, route and frequency without editing', async () => {
  for (const [suffix, expected] of [['', /administered dose/], ['15 mg, strength ', /product strength/], ['15 mg, doseForm ', /dose form/], ['15 mg, route ', /PO, IV/], ['15 mg, frequency ', /QD, BID/]]) {
    assert.match((await help('Medication aspirin: ' + suffix)).message, expected);
  }
});
test('suggestions run only for unchanged editor context', async () => {
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
