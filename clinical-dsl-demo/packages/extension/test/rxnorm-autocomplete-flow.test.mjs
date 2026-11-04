import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createMessageConnection, IPCMessageReader, IPCMessageWriter } from 'vscode-languageserver/node';

// Synthetic catalog data: these identifiers are test fixtures, not RxNorm claims.
const release = '2026-10-05';
const product = { rxcui: '900001', display: 'aspirin synthetic product', tty: 'SCD', release };
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'clinical-autocomplete-flow-'));
const serverFile = path.join(temporary, 'server.cjs');
await build({
    absWorkingDir: root,
    entryPoints: ['packages/extension/src/language/main.ts'],
    alias: { 'clinical-dsl-language': path.join(root, 'packages/language/src/index.ts') },
    outfile: serverFile, bundle: true, platform: 'node', format: 'cjs'
});
after(() => rm(temporary, { recursive: true, force: true }));

async function catalog(t, handler) {
    const requests = [];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        requests.push(url);
        const payload = handler ? await handler(url) : {
            schemaVersion: '1', release, query: url.searchParams.get('q'), items: [product], hasMore: false
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function languageServer(t, url, configuration) {
    const child = fork(serverFile, ['--node-ipc'], { silent: true, execArgv: [] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const connection = createMessageConnection(new IPCMessageReader(child), new IPCMessageWriter(child));
    const listeners = new Set();
    connection.onNotification('clinical-dsl/showPlansReady', message => {
        for (const listener of listeners) listener(message);
    });
    connection.onNotification('textDocument/publishDiagnostics', () => {});
    connection.onNotification('window/logMessage', () => {});
    connection.onRequest('client/registerCapability', () => null);
    if (configuration) connection.onRequest('workspace/configuration', params =>
        Promise.all(params.items.map(item => configuration(item))));
    connection.listen();
    t.after(() => { connection.dispose(); child.kill(); });
    await connection.sendRequest('initialize', {
        processId: process.pid, rootUri: null, workspaceFolders: [],
        capabilities: configuration ? { workspace: { configuration: true } } : {},
        initializationOptions: { rxnormSearch: { enabled: true, url, release } }
    });
    await connection.sendNotification('initialized', {});
    async function update(uri, text, version = 1) {
        const ready = new Promise((resolve, reject) => {
            const listener = message => {
                if (message.uri === uri && message.version === version) {
                    clearTimeout(timer); listeners.delete(listener); resolve();
                }
            };
            const timer = setTimeout(() => {
                listeners.delete(listener);
                reject(new Error(`No validation for ${uri} version ${version}: ${output}`));
            }, 5000);
            listeners.add(listener);
        });
        await connection.sendNotification(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? {
            textDocument: { uri, languageId: 'clinical-dsl', version, text }
        } : { textDocument: { uri, version }, contentChanges: [{ text }] });
        await ready;
    }
    return {
        connection, update,
        complete: (uri, text, offset = text.length) => connection.sendRequest('textDocument/completion', {
            textDocument: { uri }, position: positionAt(text, offset), context: { triggerKind: 1 }
        }),
        preview: (uri, version) => connection.sendRequest('clinical-dsl/getShowPlans', { uri, version })
    };
}

function positionAt(text, offset) {
    const before = text.slice(0, offset);
    return { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 };
}
function offsetAt(text, position) {
    const lines = text.split('\n');
    return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
}
function applyCompletion(text, item) {
    assert.ok(item.textEdit, 'Completion must explicitly delimit the replacement');
    const edits = [item.textEdit, ...(item.additionalTextEdits ?? [])].map(edit => ({
        start: offsetAt(text, edit.range.start), end: offsetAt(text, edit.range.end), text: edit.newText
    })).sort((a, b) => b.start - a.start || b.end - a.end);
    let lastStart = text.length + 1;
    for (const edit of edits) {
        assert.ok(edit.end <= lastStart, 'Completion edits must not overlap');
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
        lastStart = edit.start;
    }
    return text;
}
function selected(result) {
    const item = result?.items?.find(item => item.label.includes(product.display));
    assert.ok(item, `Expected synthetic product among ${JSON.stringify(result?.items?.map(item => item.label))}`);
    return item;
}

test('typing a prefix, accepting its edits and reopening preserves exact product identity', { timeout: 15000 }, async t => {
    const backend = await catalog(t);
    const server = await languageServer(t, backend.url);
    const uri = 'file:///rxnorm-flow/new.clinical';
    const draft = 'mEdIcAtIoN aSpI';
    await server.update(uri, draft);
    const completed = applyCompletion(draft, selected(await server.complete(uri, draft)));
    assert.match(completed, /rxcui\s+"900001"/);
    assert.match(completed, /rxnormRelease\s+"2026-10-05"/);
    assert.doesNotMatch(completed, /\b(?:dose|route|frequency)\b/i, 'Product choice must not invent administration details');
    const alias = /^medication\s+(\w+)/i.exec(completed)[1];
    const text = `Patient Alice: age 45, condition Fever\n${completed} dose 10mg route PO frequency BID\nPlan DemoPlan: for Alice prescribe ${alias}\nshow DemoPlan`;
    await server.update(uri, text, 2);
    const preview = await server.preview(uri, 2);
    assert.equal(preview.items[0].error, undefined);
    const medication = JSON.parse(preview.items[0].json).medication;
    assert.deepEqual(medication.productBinding, { rxcui: product.rxcui, release });
    assert.deepEqual(medication.dose, { amount: 10, unit: 'mg' });
    await server.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
    await server.update(uri, text);
    assert.deepEqual(JSON.parse((await server.preview(uri, 1)).items[0].json).medication, medication);
    assert.equal(backend.requests.length, 1);
    assert.equal(backend.requests[0].pathname, '/products');
    assert.equal(backend.requests[0].searchParams.get('q'), 'aspi');
    assert.equal(backend.requests[0].searchParams.get('release'), release);
    assert.deepEqual([...backend.requests[0].searchParams.keys()].sort(), ['limit', 'q', 'release']);
});

test('selecting another product preserves the existing alias, Plan references and administration fields', { timeout: 15000 }, async t => {
    const backend = await catalog(t);
    const server = await languageServer(t, backend.url);
    const uri = 'file:///rxnorm-flow/reselect.clinical';
    const text = `Patient Alice: age 45, condition Fever\nMedication aspiAlias: frequency BID rxcui "900002" route PO rxnormRelease "2026-10-05" dose 10mg\nPlan DemoPlan: for Alice prescribe aspiAlias\nshow DemoPlan`;
    await server.update(uri, text);
    const cursor = text.indexOf('aspiAlias') + 4;
    const changed = applyCompletion(text, selected(await server.complete(uri, text, cursor)));
    assert.match(changed, /Medication aspiAlias:/);
    assert.match(changed, /prescribe aspiAlias/);
    assert.equal((changed.match(/\brxcui\b/g) ?? []).length, 1);
    assert.equal((changed.match(/\brxnormRelease\b/g) ?? []).length, 1);
    await server.update(uri, changed, 2);
    const preview = await server.preview(uri, 2);
    assert.equal(preview.items[0].error, undefined);
    const medication = JSON.parse(preview.items[0].json).medication;
    assert.equal(medication.name, 'aspiAlias');
    assert.deepEqual(medication.productBinding, { rxcui: product.rxcui, release });
    assert.deepEqual(medication.dose, { amount: 10, unit: 'mg' });
    assert.equal(medication.route, 'PO');
    assert.equal(medication.frequency, 'BID');
});

test('product search inside the RxCUI field works for an arbitrary existing alias', { timeout: 10000 }, async t => {
    const backend = await catalog(t);
    const server = await languageServer(t, backend.url);
    const uri = 'file:///rxnorm-flow/binding-field.clinical';
    const text = `Patient Alice: age 45, condition Fever\nMedication MorningMed: dose 10mg rxcui "aspi" rxnormRelease "2025-01-01" route PO frequency BID\nPlan DemoPlan: prescribe MorningMed for Alice\nshow DemoPlan`;
    await server.update(uri, text);
    const changed = applyCompletion(text, selected(await server.complete(uri, text, text.indexOf('aspi') + 4)));
    assert.match(changed, /Medication MorningMed:/);
    assert.match(changed, /prescribe MorningMed/);
    assert.doesNotMatch(changed, /2025-01-01/);
    await server.update(uri, changed, 2);
    const preview = await server.preview(uri, 2);
    assert.equal(preview.items[0].error, undefined);
    const medication = JSON.parse(preview.items[0].json).medication;
    assert.equal(medication.name, 'MorningMed');
    assert.deepEqual(medication.productBinding, { rxcui: product.rxcui, release });
    assert.deepEqual(medication.dose, { amount: 10, unit: 'mg' });
});

test('non-product or wrong-release search responses cannot insert a binding', { timeout: 15000 }, async t => {
    const backend = await catalog(t, url => ({
        schemaVersion: '1', release, query: url.searchParams.get('q'),
        items: [{ ...product, tty: 'IN', release: '2025-01-01' }], hasMore: false
    }));
    const server = await languageServer(t, backend.url);
    const uri = 'file:///rxnorm-flow/invalid.clinical';
    const text = 'medication aspi';
    await server.update(uri, text);
    const result = await server.complete(uri, text);
    assert.ok(!result?.items?.some(item => JSON.stringify(item).includes('900001')));
});

for (const otherDocument of [false, true]) {
    test(`slow search does not block validation after ${otherDocument ? 'another document opens' : 'the active document changes'}`, { timeout: 10000 }, async t => {
        let received;
        const requestReceived = new Promise(resolve => { received = resolve; });
        let releaseResponse;
        const responseAllowed = new Promise(resolve => { releaseResponse = resolve; });
        const backend = await catalog(t, async url => {
            received();
            await responseAllowed;
            return { schemaVersion: '1', release, query: url.searchParams.get('q'), items: [product], hasMore: false };
        });
        const server = await languageServer(t, backend.url);
        const uri = 'file:///rxnorm-flow/slow.clinical';
        const draft = 'medication aspi';
        await server.update(uri, draft);
        const pending = server.complete(uri, draft).catch(error => {
            assert.ok([-32800, -32801, -32802].includes(error.code), `Unexpected completion failure: ${error}`);
            return undefined;
        });
        await requestReceived;
        let timeout;
        try {
            const update = otherDocument
                ? server.update('file:///rxnorm-flow/other.clinical', 'Patient Alice: age 45, condition Fever')
                : server.update(uri, 'medication different', 2);
            await Promise.race([update, new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Validation waited for the outstanding HTTP response')), 1000);
            })]);
            const result = await pending;
            assert.ok(!result?.items?.some(item => JSON.stringify(item).includes('900001')),
                'A cancelled lookup must not return a binding from stale document context');
        } finally {
            clearTimeout(timeout);
            releaseResponse();
        }
    });
}

test('a synonym hit remains visible even when the product display does not start with the typed prefix', { timeout: 10000 }, async t => {
    const synonymProduct = { ...product, display: 'Acetyl synthetic synonym product' };
    const backend = await catalog(t, url => ({
        schemaVersion: '1', release, query: url.searchParams.get('q'), items: [synonymProduct], hasMore: false
    }));
    const server = await languageServer(t, backend.url);
    const uri = 'file:///rxnorm-flow/synonym.clinical';
    const text = 'medication aspi';
    await server.update(uri, text);
    const result = await server.complete(uri, text);
    const item = result?.items?.find(item => item.label.includes(synonymProduct.display));
    assert.ok(item, 'Backend synonym matches should remain suggestions');
    assert.match(item.filterText ?? item.label, /^aspi/i, 'VS Code filtering must retain the synonym result');
    assert.match(applyCompletion(text, item), /rxcui\s+"900001"/);
});

test('autocomplete honors document-scoped RxNorm settings from the language client', { timeout: 10000 }, async t => {
    const backend = await catalog(t);
    const observedScopes = [];
    const server = await languageServer(t, backend.url, item => {
        if (item.section !== 'clinicalDsl.rxnorm') return {};
        observedScopes.push(item.scopeUri);
        return { searchEnabled: item.scopeUri.endsWith('enabled.clinical'), searchUrl: backend.url, release };
    });
    const draft = 'medication aspi';
    const disabled = 'file:///rxnorm-flow/disabled.clinical';
    await server.update(disabled, draft);
    const disabledResult = await server.complete(disabled, draft);
    assert.ok(!disabledResult?.items?.some(item => JSON.stringify(item).includes('900001')));
    assert.equal(backend.requests.length, 0);
    const enabled = 'file:///rxnorm-flow/enabled.clinical';
    await server.update(enabled, draft);
    selected(await server.complete(enabled, draft));
    assert.deepEqual(observedScopes, [disabled, enabled]);
    assert.equal(backend.requests.length, 1);
});

test('an unresponsive client configuration request cannot block document parsing', { timeout: 10000 }, async t => {
    let requested;
    const received = new Promise(resolve => { requested = resolve; });
    let releaseSettings;
    const settings = new Promise(resolve => { releaseSettings = resolve; });
    const backend = await catalog(t);
    const server = await languageServer(t, backend.url, item => {
        if (item.section !== 'clinicalDsl.rxnorm') return {};
        requested();
        return settings;
    });
    const uri = 'file:///rxnorm-flow/config-wait.clinical';
    const draft = 'medication aspi';
    await server.update(uri, draft);
    const pending = server.complete(uri, draft).catch(error => {
        assert.ok([-32800, -32801, -32802].includes(error.code));
        return undefined;
    });
    await received;
    let timeout;
    try {
        await Promise.race([
            server.update(uri, 'medication another', 2),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Configuration RPC blocked document validation')), 600);
            })
        ]);
        const result = await pending;
        assert.ok(!result?.items?.some(item => JSON.stringify(item).includes('900001')));
        assert.equal(backend.requests.length, 0);
    } finally {
        clearTimeout(timeout);
        releaseSettings({ searchEnabled: true, searchUrl: backend.url, release });
    }
});

test('bridge export retains a selected product after editor completion', { timeout: 15000,
    skip: !process.env.SCALA_BRIDGE_ROOT && 'Set SCALA_BRIDGE_ROOT to the companion Scala repository to check the bridge'
}, async t => {
    const backend = await catalog(t);
    const server = await languageServer(t, backend.url);
    const draft = 'medication aspi';
    const uri = 'file:///rxnorm-flow/export.clinical';
    await server.update(uri, draft);
    const completed = applyCompletion(draft, selected(await server.complete(uri, draft)));
    const alias = /^medication\s+(\w+)/i.exec(completed)[1];
    const input = path.join(temporary, 'completed.clinical');
    const text = `Patient Alice: age 45, condition Fever\n${completed} dose 10mg route PO frequency BID\nPlan DemoPlan: for Alice prescribe ${alias}\nshow DemoPlan`;
    await writeFile(input, text);
    const { exportDocument } = await import(pathToFileURL(path.join(process.env.SCALA_BRIDGE_ROOT, 'bridge/export-ast.mjs')).href);
    const request = await exportDocument({ langiumRoot: root, input, release });
    assert.equal(request.schemaVersion, '2');
    assert.equal(request.policyVersion, 'explicit-product-v1');
    assert.deepEqual(request.mentions[0].productBinding, { rxcui: product.rxcui, release });
    assert.equal(request.mentions[0].originalText, alias);
    const source = request.mentions[0].source;
    assert.equal(text.slice(source.start.offset, source.end.offset), source.text);
});
