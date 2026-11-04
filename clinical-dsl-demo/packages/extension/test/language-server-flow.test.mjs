import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createMessageConnection, IPCMessageReader, IPCMessageWriter } from 'vscode-languageserver/node';

// Exercise the real server entry point over the same IPC transport used by VS Code.
// Build from source so a stale extension bundle cannot make this test pass.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'clinical-lsp-flow-'));
const serverFile = path.join(temporary, 'server.cjs');
await build({
    absWorkingDir: root,
    entryPoints: ['packages/extension/src/language/main.ts'],
    alias: { 'clinical-dsl-language': path.join(root, 'packages/language/src/index.ts') },
    outfile: serverFile,
    bundle: true,
    platform: 'node',
    format: 'cjs'
});
after(() => rm(temporary, { recursive: true, force: true }));

async function startServer(t) {
    const child = fork(serverFile, ['--node-ipc'], { silent: true, execArgv: [] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const connection = createMessageConnection(new IPCMessageReader(child), new IPCMessageWriter(child));
    const listeners = new Set();
    connection.onNotification('clinical-dsl/showPlansReady', message => {
        for (const listener of listeners) listener(message);
    });
    // Diagnostics are independently produced by Langium; getShowPlans must apply
    // them before projecting any plain JSON that a preview could display.
    connection.onNotification('textDocument/publishDiagnostics', () => {});
    connection.onNotification('window/logMessage', () => {});
    connection.listen();
    t.after(async () => {
        connection.dispose();
        child.kill();
    });
    await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: null,
        workspaceFolders: [],
        capabilities: {}
    });
    await connection.sendNotification('initialized', {});

    async function update(uri, text, version = 1) {
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                listeners.delete(listener);
                reject(new Error(`No validated document ${uri} at version ${version}. ${output}`));
            }, 5000);
            const listener = message => {
                if (message.uri === uri && message.version === version) {
                    clearTimeout(timer);
                    listeners.delete(listener);
                    resolve();
                }
            };
            listeners.add(listener);
        });
        if (version === 1) {
            await connection.sendNotification('textDocument/didOpen', {
                textDocument: { uri, languageId: 'clinical-dsl', version, text }
            });
        } else {
            await connection.sendNotification('textDocument/didChange', {
                textDocument: { uri, version },
                contentChanges: [{ text }]
            });
        }
        await ready;
    }
    const preview = (uri, version) => connection.sendRequest('clinical-dsl/getShowPlans', { uri, version });
    return { update, preview };
}

test('real language server projects normalized data with canonical plan and reference names', { timeout: 10000 }, async t => {
    const server = await startServer(t);
    const uri = 'file:///clinical-flow/round-trip.clinical';
    const text = `Patient Po: age 45, condition Dose
mEdIcAtIoN DemoMed: frequency bId, dose 10MG, strength 160MG/5ML, doseForm "Metered Dose Inhaler", route pO
pLaN DemoPlan: prescribe demomed, for po
SHOW demoplan`;
    await server.update(uri, text);
    const response = await server.preview(uri, 1);
    assert.equal(response.version, 1);
    assert.equal(response.items.length, 1);
    const item = response.items[0];
    assert.equal(item.error, undefined);
    assert.equal(item.planName, 'DemoPlan');
    assert.equal(item.sourceText, 'SHOW demoplan');
    assert.equal(text.slice(item.startOffset, item.endOffset), item.sourceText);
    assert.deepEqual(JSON.parse(item.json), {
        name: 'DemoPlan',
        patient: { name: 'Po', age: 45, condition: 'Dose' },
        medication: {
            name: 'DemoMed',
            dose: { amount: 10, unit: 'mg' },
            productStrength: '160 mg/5 ml',
            doseForm: 'Metered Dose Inhaler',
            route: 'PO',
            frequency: 'BID'
        }
    });
});

test('real language server blocks invalid snapshots and rejects stale document versions', { timeout: 10000 }, async t => {
    const server = await startServer(t);
    const uri = 'file:///clinical-flow/editing.clinical';
    const valid = `Patient Alice: age 45, condition Fever
Medication DemoMed: dose 10mg, route PO, frequency BID
Plan DemoPlan: for Alice, prescribe DemoMed
show demoplan`;
    const incomplete = valid.replace(', route PO, frequency BID', '');
    await server.update(uri, incomplete);
    const before = await server.preview(uri, 1);
    assert.equal(before.items[0].json, undefined);
    assert.match(before.items[0].error, /Missing route/);
    assert.match(before.items[0].error, /Missing frequency/);

    await server.update(uri, valid, 2);
    assert.equal(await server.preview(uri, 1), null);
    const corrected = await server.preview(uri, 2);
    assert.equal(corrected.items[0].error, undefined);
    assert.equal(JSON.parse(corrected.items[0].json).medication.dose.amount, 10);

    await server.update(uri, valid.replace('dose 10mg', 'dose 0mg'), 3);
    assert.equal(await server.preview(uri, 2), null);
    const invalidated = await server.preview(uri, 3);
    assert.equal(invalidated.items[0].json, undefined);
    assert.match(invalidated.items[0].error, /greater than zero/);
});

test('real language server refuses an ambiguous cross-file medication before JSON projection', { timeout: 10000 }, async t => {
    const server = await startServer(t);
    await server.update('file:///clinical-flow/a.clinical', 'Medication DemoMed: dose 10mg, route PO, frequency BID');
    await server.update('file:///clinical-flow/b.clinical', 'Medication demomed: dose 20mg, route IV, frequency PRN');
    const uri = 'file:///clinical-flow/consumer.clinical';
    await server.update(uri, `Patient Alice: age 45, condition Fever
Plan DemoPlan: for Alice, prescribe DEMOMED
show DemoPlan`);
    const response = await server.preview(uri, 1);
    assert.equal(response.items[0].json, undefined);
    assert.match(response.items[0].error, /ambiguous|resolve|reference/i);
});

test('workspace edits invalidate and restore a dependent preview without editing the plan', { timeout: 10000 }, async t => {
    const server = await startServer(t);
    await server.update('file:///clinical-flow/original.clinical', 'Medication DemoMed: dose 10mg, route PO, frequency BID');
    const planUri = 'file:///clinical-flow/dependent.clinical';
    await server.update(planUri, `Patient Alice: age 45, condition Fever
Plan DemoPlan: for Alice, prescribe demomed
show DemoPlan`);
    const before = await server.preview(planUri, 1);
    assert.equal(JSON.parse(before.items[0].json).medication.dose.amount, 10);

    const conflictUri = 'file:///clinical-flow/conflict.clinical';
    await server.update(conflictUri, 'Medication DEMOMED: dose 20mg, route IV, frequency PRN');
    const ambiguous = await server.preview(planUri, 1);
    assert.equal(ambiguous.items[0].json, undefined);
    assert.match(ambiguous.items[0].error, /ambiguous|resolve|reference/i);

    await server.update(conflictUri, 'Medication OtherMed: dose 20mg, route IV, frequency PRN', 2);
    const restored = await server.preview(planUri, 1);
    assert.equal(restored.items[0].error, undefined);
    assert.equal(JSON.parse(restored.items[0].json).medication.dose.amount, 10);
});

test('an unfinished show statement returns diagnostics instead of failing the preview request', { timeout: 10000 }, async t => {
    const server = await startServer(t);
    const uri = 'file:///clinical-flow/unfinished-show.clinical';
    const declarations = `Patient Alice: age 45, condition Fever
Medication DemoMed: dose 10mg, route PO, frequency BID
Plan DemoPlan: for Alice, prescribe DemoMed
`;
    for (const [index, suffix] of ['show', 'show '].entries()) {
        const version = index + 1;
        await server.update(uri, declarations + suffix, version);
        const response = await server.preview(uri, version);
        assert.equal(response.version, version);
        assert.equal(response.items.length, 1);
        assert.equal(response.items[0].json, undefined);
        assert.match(response.items[0].error, /expecting|syntax|reference|plan/i);
        assert.doesNotMatch(response.items[0].error, /error occurred during validation|TypeError/i);
    }
});

test('real language server persists product binding in JSON and blocks incomplete binding edits', { timeout: 10000 }, async t => {
    const server = await startServer(t);
    const uri = 'file:///clinical-flow/bound-product.clinical';
    const text = `Patient Alice: age 45, condition Fever
Medication ChosenProduct: RXNORMRELEASE "2026-10-05" dose 10mg RXCUI "900001" route PO frequency BID
Plan DemoPlan: prescribe chosenproduct, for Alice
show DemoPlan`;
    await server.update(uri, text);
    const response = await server.preview(uri, 1);
    assert.equal(response.items[0].error, undefined);
    const medication = JSON.parse(response.items[0].json).medication;
    assert.deepEqual(medication.productBinding, { rxcui: '900001', release: '2026-10-05' });
    assert.equal(medication.name, 'ChosenProduct');
    assert.deepEqual(medication.dose, { amount: 10, unit: 'mg' });

    await server.update(uri, text.replace('RXNORMRELEASE "2026-10-05" ', ''), 2);
    const invalid = await server.preview(uri, 2);
    assert.equal(invalid.items[0].json, undefined);
    assert.match(invalid.items[0].error, /requires rxnormRelease/);
});
