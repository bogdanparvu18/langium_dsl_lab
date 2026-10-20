// UI behavior tests with simulated VS Code/processes. No PostgreSQL or RxNorm files required.
// Run from clinical-dsl-demo: node --test packages/extension/test/rxnorm.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('../src/extension/rxnorm.ts', import.meta.url));
const bundle = (await build({ entryPoints: [source], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['vscode'] })).outputFiles[0].text;
const previewSource = fileURLToPath(new URL('../src/extension/rxnorm-preview.ts', import.meta.url));
const previewBundle = (await build({ entryPoints: [previewSource], bundle: true, write: false,
    platform: 'node', format: 'cjs' })).outputFiles[0].text;
const previewModule = { exports: {} };
vm.runInNewContext(previewBundle, { module: previewModule, exports: previewModule.exports });
const { withRxNormPreview, rxnormPreviewTitle } = previewModule.exports;
const mainSource = fileURLToPath(new URL('../src/extension/main.ts', import.meta.url));
const mainBundle = (await build({ entryPoints: [mainSource], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['vscode', './rxnorm.js', 'vscode-languageclient/node'] })).outputFiles[0].text;

async function harness(options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rxnorm-extension-test-'));
    const scalaRoot = path.join(root, 'Scala Project');
    const langiumRoot = path.join(root, 'Langium Project');
    const toolsRoot = path.join(root, 'tools');
    const layout = { javaHome: path.join(root, 'Java Runtime'), nodeHome: path.join(root, 'Node Runtime'),
        sbtHome: path.join(root, 'sbt') };
    const java = path.join(layout.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const node = path.join(layout.nodeHome, process.platform === 'win32' ? 'node.exe' : 'bin/node');
    for (const file of [java, node, path.join(layout.sbtHome, 'bin/sbt-launch.jar'),
        path.join(scalaRoot, 'bridge/export-ast.mjs'), path.join(scalaRoot, 'build.sbt'),
        path.join(langiumRoot, 'packages/language/out/index.js')]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'test placeholder');
    }
    await mkdir(toolsRoot);
    await writeFile(path.join(toolsRoot, 'layout.json'), JSON.stringify(layout));
    const uri = fileUri(path.join(langiumRoot, 'new.clinical'));
    const medicationName = options.medicationName ?? 'paracetamol';
    const text = `medication ${medicationName} { 1 mg route PO frequency PRN }`;
    const document = { uri, version: 1, isDirty: false, isClosed: false,
        languageId: 'clinical-dsl', getText() { return this.text; }, text };
    await writeFile(uri.fsPath, text);
    const configValues = { scalaRoot, toolsRoot, release: '2026-10-05', onSave: true, ...options.config };
    const config = { get(key, fallback) { return configValues[key] ?? fallback; } };
    const commands = new Map(), events = {}, notices = [], entries = new Map(), processes = [], logs = [];
    const output = { append: text => logs.push(text), appendLine: text => logs.push(text + '\n'),
        show() {}, dispose() {} };
    const collection = { set: (uri, items) => entries.set(uri.toString(), items),
        delete: uri => entries.delete(uri.toString()), clear: () => entries.clear(), dispose() {} };
    function listen(event) {
        return callback => { events[event] = callback; return { dispose() {} }; };
    }
    let releaseJava;
    let startedJava;
    const javaStarted = new Promise(resolve => { startedJava = resolve; });
    const javaGate = options.pauseJava ? new Promise(resolve => { releaseJava = resolve; }) : Promise.resolve();
    const spawn = (executable, args, spawnOptions) => {
        processes.push({ executable, args, options: spawnOptions });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => { child.emit('close', null); return true; };
        setImmediate(async () => {
            try {
                if (executable === node) {
                    if (options.exportFails) { child.stderr.write('Invalid DSL / unresolved plan reference'); child.emit('close', 1); return; }
                    const input = args[args.indexOf('--input') + 1];
                    const documentText = await readFile(input, 'utf8');
                    const mention = { id: `DemoPlan:${medicationName}`, orderId: 'DemoPlan', originalText: medicationName, role: 'medication',
                        ...(options.product ? { productStrength: '500 mg', doseForm: 'Oral Tablet' } : {}),
                        source: { uri: uri.toString(), start: { line: 0, character: 0, offset: 0 },
                            end: { line: 0, character: text.length, offset: text.length }, text } };
                    await writeFile(args[args.indexOf('--output') + 1], JSON.stringify({
                        document: { uri: uri.toString(), text: documentText }, mentions: [mention]
                    }));
                } else {
                    assert.equal(executable, java);
                    startedJava();
                    await javaGate;
                    if (options.resolveFails) { child.stderr.write('PostgreSQL connection refused'); child.emit('close', 1); return; }
                    const [, input, output] = /^run resolve "([^"]+)" "([^"]+)"$/.exec(args.at(-1));
                    const request = JSON.parse(await readFile(input, 'utf8'));
                    const status = options.status ?? (options.unresolved ? 'unresolved' : 'resolved');
                    const resolved = status === 'resolved';
                    await writeFile(output, JSON.stringify({ schemaVersion: '2', terminologyRelease: options.wrongRelease ? 'other' : '2026-10-05',
                        terminologyScope: 'test-scope', snapshotFingerprint: 'test-fingerprint',
                        resolutions: [{ mention: request.mentions[0], status,
                            initialConcept: resolved ? { rxcui: '161', display: 'acetaminophen', tty: 'IN' } : null,
                            ...(options.product && resolved ? { selectedProduct: { rxcui: '900001', display: 'synthetic 500 MG Oral Tablet', tty: 'SCD' },
                                productEvidence: { strength: { value: '500 MG', atui: 'synthetic-attribute' } } } : {}),
                            ingredients: [], diagnostics: [], candidates: [] }] }));
                }
                child.emit('close', 0);
            } catch (error) { child.emit('error', error); }
        });
        return child;
    };
    const providers = {};
    const vscode = {
        Uri: { parse: value => fileUri(fileURLToPath(value)) },
        Disposable: class { constructor(callback) { this.dispose = callback; } },
        EventEmitter: class {
            listeners = new Set();
            event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; };
            fire(value) { for (const callback of this.listeners) callback(value); }
            dispose() { this.listeners.clear(); }
        },
        Range: class { constructor(...args) { this.values = args; } contains() { return true; } },
        MarkdownString: class {
            text = ''; blocks = [];
            appendText(value) { this.text += value; }
            appendMarkdown(value) { this.text += value; }
            appendCodeblock(value) { this.blocks.push(value); }
        },
        Hover: class { constructor(contents, range) { Object.assign(this, { contents, range }); } },
        CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
        DiagnosticSeverity: { Error: 0, Information: 2, Warning: 1 }, ProgressLocation: { Window: 10 },
        languages: { createDiagnosticCollection: () => collection,
            registerHoverProvider: (_selector, provider) => { providers.hover = provider; return { dispose() {} }; },
            registerCodeLensProvider: (_selector, provider) => { providers.codeLens = provider; return { dispose() {} }; } },
        window: { activeTextEditor: { document }, createOutputChannel: () => output,
            withProgress: async (_options, callback) => callback(),
            showInformationMessage: async message => { notices.push({ type: 'info', message }); },
            showWarningMessage: async message => { notices.push({ type: 'warning', message }); },
            showErrorMessage: async message => { notices.push({ type: 'error', message }); },
            showInputBox: async () => 'replacement-secret' },
        workspace: { isTrusted: true, getConfiguration: () => config,
            onDidSaveTextDocument: listen('save'), onDidChangeTextDocument: listen('change'),
            onDidCloseTextDocument: listen('close'), onDidChangeConfiguration: listen('configuration') },
        commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; } }
    };
    const savedSecrets = [];
    const context = { extensionPath: path.join(langiumRoot, 'packages/extension'),
        globalStorageUri: { fsPath: path.join(root, 'storage') }, subscriptions: [],
        asAbsolutePath: file => path.join(langiumRoot, 'packages/extension', file),
        secrets: { get: async () => 'private-test-password', store: async (...args) => savedSecrets.push(args) } };
    const module = { exports: {} };
    vm.runInNewContext(bundle, { module, exports: module.exports, Buffer, process, setTimeout, clearTimeout,
        require: name => name === 'vscode' ? vscode : name === 'node:child_process' ? { spawn } : require(name) });
    const rxnorm = module.exports.registerRxNorm(context);
    const planJson = JSON.stringify({ name: 'DemoPlan', patient: { name: 'DemoPatient' },
        medication: { name: medicationName, dose: { amount: 1, unit: 'mg' }, route: 'PO', frequency: 'PRN' } });
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    async function activatePreview() {
        class LanguageClient {
            async start() {}
            onNotification() { return { dispose() {} }; }
            async sendRequest() {
                return { uri: document.uri.toString(), version: document.version,
                    items: [{ planName: 'DemoPlan', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                        startOffset: 0, json: planJson, ...(options.serverError ? { error: options.serverError } : {}) }] };
            }
        }
        const mainModule = { exports: {} };
        vm.runInNewContext(mainBundle, { module: mainModule, exports: mainModule.exports, process, setTimeout, clearTimeout,
            require: name => name === 'vscode' ? vscode : name === './rxnorm.js' ? { registerRxNorm: () => rxnorm }
                : name === 'vscode-languageclient/node' ? { LanguageClient, TransportKind: { ipc: 1 } } : require(name) });
        await mainModule.exports.activate(context);
    }
    return { document, context, commands, events, notices, entries, processes, logs, javaStarted, releaseJava,
        rxnorm, planJson, activatePreview, providers, token,
        savedSecrets, resolve: () => commands.get('clinical-dsl.rxnorm.resolve')(),
        async cleanup() { context.subscriptions.toReversed().forEach(d => d.dispose()); await rm(root, { recursive: true, force: true }); } };
}

function fileUri(file) {
    return { scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href };
}
async function eventually(check) {
    for (let i = 0; i < 500; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Timed out waiting for extension result');
}

test('manual resolve: subprocess arguments, password isolation, diagnostic and notification', async t => {
    const h = await harness(); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(h.processes.length, 2);
    assert.equal(h.processes[1].options.env.PGPASSWORD, 'private-test-password');
    assert.equal(h.processes[1].options.shell, false);
    assert.match(h.notices.at(-1).message, /paracetamol: RxCUI 161 \| acetaminophen \| IN/);
    assert.equal(h.entries.get(h.document.uri.toString())[0].severity, 2);
    assert.match(h.logs.join(''), /paracetamol\tmedication\tresolved\t161\tacetaminophen\tIN/);
    assert.doesNotMatch(h.logs.join(''), /private-test-password/);
    assert.equal((await readdir(h.context.globalStorageUri.fsPath)).length, 0);
});

test('saving a clinical file runs the resolution automatically', async t => {
    const h = await harness(); t.after(() => h.cleanup());
    h.events.save(h.document);
    await eventually(() => h.notices.length > 0);
    assert.match(h.notices.at(-1).message, /RxCUI 161/);
});

test('onSave=false retains the manual command', async t => {
    const h = await harness({ config: { onSave: false } }); t.after(() => h.cleanup());
    h.events.save(h.document);
    assert.equal(h.processes.length, 0);
    await h.resolve();
    assert.equal(h.processes.length, 2);
});

test('unresolved medication produces an error without a fabricated concept', async t => {
    const h = await harness({ unresolved: true }); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(h.notices.at(-1).type, 'error');
    assert.match(h.notices.at(-1).message, /medication unknown/);
    assert.doesNotMatch(h.notices.at(-1).message, /161|acetaminophen/);
    assert.equal(h.entries.get(h.document.uri.toString())[0].severity, 0);
    assert.equal(h.entries.get(h.document.uri.toString())[0].code, 'MEDICATION_UNKNOWN');
});

test('Langium validation failure prevents Scala execution', async t => {
    const h = await harness({ exportFails: true }); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(h.processes.length, 1);
    assert.equal(h.entries.size, 0);
    assert.equal(h.notices.at(-1).type, 'warning');
});

test('an edit during Scala execution suppresses the obsolete result', async t => {
    const h = await harness({ pauseJava: true }); t.after(() => h.cleanup());
    const pending = h.resolve();
    await h.javaStarted;
    h.document.version++;
    h.document.isDirty = true;
    h.events.change({ document: h.document, contentChanges: [{}] });
    h.releaseJava();
    await pending;
    assert.equal(h.entries.size, 0);
    assert.equal(h.notices.length, 0);
});

test('Scala output with a different release is rejected', async t => {
    const h = await harness({ wrongRelease: true }); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(h.entries.size, 0);
    assert.match(h.notices.at(-1).message, /Unexpected Scala report/);
});

test('the password command stores the secret without logging it', async t => {
    const h = await harness(); t.after(() => h.cleanup());
    await h.commands.get('clinical-dsl.rxnorm.setPassword')();
    assert.equal(h.savedSecrets[0][1], 'replacement-secret');
    assert.doesNotMatch(h.logs.join('') + h.notices.map(n => n.message).join(''), /replacement-secret/);
});

function preview(h, planName = 'DemoPlan') {
    return JSON.parse(withRxNormPreview(h.planJson, h.rxnorm.getPreview(h.document, planName)));
}

test('Preview JSON contains medication unknown only after Scala reports an unmatched name', async t => {
    const h = await harness({ unresolved: true, medicationName: 'QzUnknownMedicine999' });
    t.after(() => h.cleanup());
    assert.equal(preview(h).medication.rxnorm.status, 'notChecked');
    await h.resolve();
    const json = preview(h);
    assert.equal(json.medication.name, 'QzUnknownMedicine999');
    assert.equal(json.medication.rxnorm.status, 'unresolved');
    assert.equal(json.medication.rxnorm.code, 'MEDICATION_UNKNOWN');
    assert.equal(json.medication.rxnorm.error, 'medication unknown');
    assert.equal(json.medication.rxnorm.concept, null);
    assert.equal(json.medication.rxnorm.release, '2026-10-05');
    assert.equal(rxnormPreviewTitle(h.rxnorm.getPreview(h.document, 'DemoPlan')), 'Preview JSON — medication unknown');
});

test('Preview JSON preserves the plan and dose and includes a resolved concept', async t => {
    const h = await harness(); t.after(() => h.cleanup());
    await h.resolve();
    const json = preview(h);
    assert.equal(json.name, 'DemoPlan');
    assert.deepEqual(json.patient, { name: 'DemoPatient' });
    assert.deepEqual(json.medication.dose, { amount: 1, unit: 'mg' });
    assert.equal(json.medication.rxnorm.concept.rxcui, '161');
    assert.equal(json.medication.rxnorm.error, undefined);
});

test('pending verification is shown as checking, not unknown', async t => {
    const h = await harness({ pauseJava: true, unresolved: true }); t.after(() => h.cleanup());
    const pending = h.resolve();
    await h.javaStarted;
    assert.equal(preview(h).medication.rxnorm.status, 'checking');
    assert.equal(preview(h).medication.rxnorm.error, undefined);
    h.releaseJava();
    await pending;
    assert.equal(preview(h).medication.rxnorm.error, 'medication unknown');
});

test('a PostgreSQL failure is unavailable and never medication unknown', async t => {
    const h = await harness({ resolveFails: true }); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(preview(h).medication.rxnorm.status, 'unavailable');
    assert.equal(preview(h).medication.rxnorm.error, undefined);
    assert.equal(h.entries.size, 0);
});

test('ambiguity is needsClarification rather than an unknown medication', async t => {
    const h = await harness({ status: 'needsClarification' }); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(preview(h).medication.rxnorm.status, 'needsClarification');
    assert.equal(preview(h).medication.rxnorm.error, undefined);
    assert.equal(h.entries.get(h.document.uri.toString())[0].severity, 1);
});

test('editing clears a previous unknown result from Preview JSON and Problems', async t => {
    const h = await harness({ unresolved: true }); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(preview(h).medication.rxnorm.error, 'medication unknown');
    h.document.version++;
    h.document.isDirty = true;
    h.events.change({ document: h.document, contentChanges: [{}] });
    assert.equal(preview(h).medication.rxnorm.status, 'notChecked');
    assert.equal(h.entries.size, 0);
});

test('a plan cannot use another plan resolution', async t => {
    const h = await harness(); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(h.rxnorm.getPreview(h.document, 'OtherPlan').kind, 'notChecked');
    const wrongJson = JSON.parse(h.planJson);
    wrongJson.medication.name = 'OtherMedication';
    assert.throws(() => withRxNormPreview(JSON.stringify(wrongJson),
        h.rxnorm.getPreview(h.document, 'DemoPlan')), /does not belong/);
});

test('changing the terminology configuration invalidates an existing preview', async t => {
    const h = await harness(); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(preview(h).medication.rxnorm.status, 'resolved');
    h.events.configuration({ affectsConfiguration: () => true });
    assert.equal(preview(h).medication.rxnorm.status, 'notChecked');
    assert.equal(h.entries.size, 0);
});

test('a newly checked document replaces a previous unknown result with its new Scala result', async t => {
    const options = { unresolved: true };
    const h = await harness(options); t.after(() => h.cleanup());
    await h.resolve();
    assert.equal(preview(h).medication.rxnorm.error, 'medication unknown');
    options.unresolved = false;
    h.document.version++;
    h.events.change({ document: h.document, contentChanges: [{}] });
    await h.resolve();
    assert.equal(preview(h).medication.rxnorm.status, 'resolved');
    assert.equal(preview(h).medication.rxnorm.error, undefined);
});

test('the actual Preview JSON hover and CodeLens display the unmatched medication error', async t => {
    const h = await harness({ unresolved: true, medicationName: 'QzUnknownMedicine999' });
    t.after(() => h.cleanup());
    await h.resolve();
    await h.activatePreview();
    const hover = await h.providers.hover.provideHover(h.document, { line: 0, character: 0 }, h.token);
    const json = JSON.parse(hover.contents.blocks[0]);
    assert.equal(json.medication.rxnorm.error, 'medication unknown');
    const lenses = await h.providers.codeLens.provideCodeLenses(h.document, h.token);
    assert.equal(lenses[0].command.title, 'Preview JSON — medication unknown');
    assert.equal(lenses[0].command.command, 'clinical-dsl.showJson.preview');
});

test('the actual hover removes the error as soon as the document is edited', async t => {
    const h = await harness({ unresolved: true }); t.after(() => h.cleanup());
    await h.resolve();
    await h.activatePreview();
    h.document.version++;
    h.document.isDirty = true;
    h.events.change({ document: h.document, contentChanges: [{}] });
    const hover = await h.providers.hover.provideHover(h.document, { line: 0, character: 0 }, h.token);
    const rxnorm = JSON.parse(hover.contents.blocks[0]).medication.rxnorm;
    assert.equal(rxnorm.status, 'notChecked');
    assert.equal(rxnorm.error, undefined);
});

test('the Preview JSON hover retains original Langium reference errors', async t => {
    const h = await harness({ serverError: 'Plan has an unresolved reference.' }); t.after(() => h.cleanup());
    await h.activatePreview();
    const hover = await h.providers.hover.provideHover(h.document, { line: 0, character: 0 }, h.token);
    assert.match(hover.contents.text, /unresolved reference/);
    assert.equal(hover.contents.blocks.length, 0);
});

test('product Preview JSON includes the selected SCD and its imported strength evidence', async t => {
    const h = await harness({ product: true }); t.after(() => h.cleanup());
    await h.resolve();
    const result = preview(h).medication.rxnorm;
    assert.equal(result.status, 'resolved');
    assert.equal(result.concept.rxcui, '161');
    assert.equal(result.selectedProduct.tty, 'SCD');
    assert.equal(result.productEvidence.strength.value, '500 MG');
    assert.match(h.notices.at(-1).message, /RxCUI 900001/);
});

test('a product-strength failure is displayed separately from medication unknown', async t => {
    const h = await harness({ product: true, status: 'productNotFound' }); t.after(() => h.cleanup());
    await h.resolve();
    const result = preview(h).medication.rxnorm;
    assert.equal(result.status, 'productNotFound');
    assert.equal(result.code, 'PRODUCT_NOT_FOUND');
    assert.doesNotMatch(result.error, /medication unknown/);
    assert.equal(h.entries.get(h.document.uri.toString())[0].severity, 0);
});
