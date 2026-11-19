import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../src/extension/', import.meta.url));
const bundle = await build({
    stdin: { contents: "export * from './regimen-edits.ts'; export { parseClinicalDocumentResult } from './context-help.ts';", resolveDir: root },
    alias: { 'clinical-dsl-language': fileURLToPath(new URL('../../language/src/index.ts', import.meta.url)) },
    platform: 'node', format: 'cjs', bundle: true, write: false, external: ['vscode']
});
const require = createRequire(import.meta.url);
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, process, console, URL, setTimeout,
    clearTimeout, TextEncoder, TextDecoder, require: name => name === 'vscode' ? {} : require(name) });
const { regimenEdits, bindingAt, parseClinicalDocumentResult } = module.exports;

const binding = { alias: 'Demo', display: 'Example 5 MG Tablet', rxcui: '900001', release: '2026-10-05' };
const selected = 'Medication Demo: product "Example 5 MG Tablet" rxcui "900001"';
const draft = (text, dose = '5 mg', frequency = '6H', target = binding) => regimenEdits(text, target, dose, frequency);

function apply(text, edits) {
    assert.ok(edits);
    return [...edits].sort((a, b) => b.start - a.start).reduce((result, { start, end, text: insert }) =>
        result.slice(0, start) + insert + result.slice(end), text);
}

test('adds a validated pair to the selected declaration and preserves comments, other orders and plan references', () => {
    const source = 'Medication Other: 10mg route IV frequency QID\r\n' + selected +
        ' /* keep */\r\n    ROUTE po, // keep trailing comment\r\nPlan P: prescribe Demo for Jane';
    const result = apply(source, draft(source, '5MG', 'q4-6h PRN'));
    assert.equal(result, source.replace('ROUTE po,', 'ROUTE po, dose 5 mg frequency 4-6H PRN'));
    const parsed = parseClinicalDocumentResult(result);
    assert.equal(parsed.parserErrors.length, 0);
    assert.equal(parsed.lexerErrors.length, 0);
    assert.equal(parsed.value.medication[1].amount, 5);
    assert.equal(parsed.value.medication[1].frequency, 'Q4-6H PRN');
    assert.equal(draft(result).length, 0);
});

test('fills a single missing field only if the existing dose or frequency agrees with the same instruction', () => {
    for (const [fields, extra] of [
        ['DoSe 05.00 /* preserve */ MG', 'frequency 6H'],
        ['5mg', 'frequency 6H'],
        ['FREQUENCY q6h', 'dose 5 mg']
    ]) {
        const source = selected + ' ' + fields;
        const result = apply(source, draft(source));
        assert.equal(result, source + ' ' + extra);
        assert.equal(parseClinicalDocumentResult(result).parserErrors.length, 0);
    }
    for (const fields of ['5mcg', '10mg', 'frequency Q4H', 'frequency "Q6H PRN"']) {
        assert.equal(draft(selected + ' ' + fields), undefined);
    }
    assert.equal(draft(selected + ' 20mg frequency BID').length, 0);
});

test('checks an explicit route against the confirmed Canadian presentation before adding reference values', () => {
    const withRoute = (field, routes) => regimenEdits(selected + field, binding, '5mg', '6H', routes);
    assert.equal(withRoute(' route IV', ['ORAL']), undefined);
    assert.equal(withRoute(' route IV route PO', ['ORAL']), undefined);
    assert.equal(withRoute('', ['ORAL']).length, 1);
    assert.equal(withRoute(' route po', ['ORAL']).length, 1);
    assert.equal(withRoute(' route IM', ['SUBCUTANEOUS', 'INTRAMUSCULAR']).length, 1);
});

test('rejects a stale identity, a duplicate alias or an incomplete or ambiguous declaration', () => {
    for (const source of [
        selected.replace('900001', '900002'), selected.replace('Example', 'Other'), selected.replace('Demo:', 'Other:'),
        selected + '\nMedication DEMO: 10mg route PO frequency QD',
        selected + ' dose', selected + ' Dose 5', selected + ' frequency', selected + ' 5mg Dose 5 mg',
        selected + ' frequency Q6H frequency BID', selected + ' rxcui "900001"', selected + ' @unexpected'
    ]) {
        assert.equal(draft(source), undefined, source);
    }
    assert.equal(bindingAt(selected + '\nMedication DEMO:', 'Demo', binding.release), undefined);
    const legacy = 'Medication Demo: rxcui "900001" rxnormRelease "2026-10-05"';
    const legacyBinding = { ...binding, display: undefined };
    assert.equal(apply(legacy, draft(legacy, '5 mg', '6H', legacyBinding)), legacy + ' dose 5 mg frequency 6H');
    assert.equal(draft(legacy, '5 mg', '6H', { ...legacyBinding, release: '2026-08-03' }), undefined);
});

test('keeps malformed text in a separate declaration intact and rejects malformed incoming values', () => {
    const source = selected + '\nMedication Another: frequency';
    assert.equal(apply(source, draft(source)), selected + ' dose 5 mg frequency 6H\nMedication Another: frequency');
    for (const [dose, frequency] of [
        ['0 mg', '6H'], ['5mg route PO', '6H'], ['NaN mg', '6H'], ['5mg', '6H route IV'],
        ['5mg', 'Q6-4H PRN']
    ]) assert.equal(draft(selected, dose, frequency), undefined);
});
