// Exercise both registered VS Code commands against a real loopback HTTP server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../../src/extension/monograph.ts', import.meta.url))],
    alias: { 'clinical-dsl-language': fileURLToPath(new URL('../../../language/src/index.ts', import.meta.url)) },
    platform: 'node', format: 'cjs', bundle: true, write: false, external: ['vscode'] })).outputFiles[0].text;
export const release = '2026-10-05';
export const bound = { alias: 'Morning', rxcui: '900001', display: 'Example 20 MG Oral Tablet', release };
export const items = ['00012345', '00012346'].map((din, i) => ({ din, drugCode: i + 1, brandName: 'Example ' + i,
    ingredients: ['Example 20 MG'], forms: ['TABLET'], routes: ['ORAL'] }));
const noopEvent = () => ({ dispose() {} });

export async function harness(t, options = {}) {
    const requests = [], notices = [], warnings = [], opened = [], picks = [], editBatches = [], details = [];
    const memory = new Map(), commands = new Map();
    const candidates = { release, rxcui: bound.rxcui, rxnormDisplay: bound.display, items };
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        requests.push({ path: url.pathname, method: req.method, query: Object.fromEntries(url.searchParams) });
        if (url.pathname !== '/products') assert.equal(req.headers['x-aurora-client'], 'vscode');
        let payload;
        switch (url.pathname) {
            case '/products':
                payload = { schemaVersion: '1', release, query: url.searchParams.get('q'), hasMore: false,
                    items: [{ ...bound, tty: 'SCD' }] };
                break;
            case '/canadian-products': payload = options.candidates ?? candidates; break;
            case '/monograph': {
                options.duringPost?.({ edit, document });
                const sha256 = 'b'.repeat(64);
                const query = new URLSearchParams(url.search);
                query.set('sha256', sha256);
                query.set('token', 'a'.repeat(64));
                payload = { status: 'available', dosagePage: 14, revision: '2025-03-04', sha256,
                    pdfPath: '/monograph.pdf?' + query, ...options.info };
                break;
            }
            default: throw new Error('Unexpected path: ' + url.pathname);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const uri = 'file:///workspace/example.clinical';
    let text = `Medication Morning: product "${bound.display}" rxcui "${bound.rxcui}" dose 5mg route PO frequency PRN`;
    const document = { uri: { toString: () => uri }, version: 1, languageId: 'clinical-dsl',
        getText: () => text, offsetAt: () => 14, positionAt: offset => offset };
    const edit = value => { document.version++; text = value; };
    const config = { get: (key, fallback) => key === 'searchUrl' ? origin : fallback };
    const vscode = {
        Uri: { parse: url => new URL(url) },
        Range: class { constructor(start, end) { this.start = start; this.end = end; } },
        env: { openExternal: async url => { opened.push(url); return true; } },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false, onCancellationRequested: noopEvent };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() {}
        },
        commands: { registerCommand(name, cb) { commands.set(name, cb); return noopEvent(); } },
        workspace: { isTrusted: true, getConfiguration: () => config, onDidChangeConfiguration: noopEvent },
        window: {
            activeTextEditor: { document, selection: { active: {} }, async edit(callback) {
                const edits = [];
                callback({ replace: (range, text) => edits.push({ ...range, text }) });
                if (options.rejectEdit) return false;
                editBatches.push(edits);
                edit([...edits].sort((a, b) => b.start - a.start)
                    .reduce((source, { start, end, text }) => source.slice(0, start) + text + source.slice(end), text));
                return true;
            } }, onDidChangeActiveTextEditor: noopEvent,
            async showQuickPick(choices) {
                picks.push(choices);
                if (options.duringPick) options.duringPick({ edit, document });
                return options.cancel ? undefined : choices.at(-1);
            },
            async showInformationMessage(message, ...args) {
                notices.push(message);
                const buttons = args.filter(arg => typeof arg === 'string');
                if (args[0]?.modal) details.push(args[0].detail);
                return options.noticeAction ? options.noticeAction(message, buttons) : buttons[0];
            },
            async showWarningMessage(message) { warnings.push(message); }
        }
    };
    const module = { exports: {} };
    vm.runInNewContext(bundle, { module, exports: module.exports, process, console, setTimeout, clearTimeout,
        URL, URLSearchParams, AbortController, AbortSignal, fetch, TextEncoder, TextDecoder,
        require: name => name === 'vscode' ? vscode : require(name) });
    const context = { subscriptions: [], workspaceState: {
        get: key => memory.get(key), update: async (key, value) => memory.set(key, value) } };
    module.exports.registerMonographs(context);
    t.after(() => { context.subscriptions.forEach(d => d.dispose()); server.closeAllConnections(); return new Promise(r => server.close(r)); });
    return { uri, commands, document, requests, notices, warnings, opened, picks, memory, edit, origin, editBatches, details,
        accept: () => commands.get('clinical-dsl.monograph.afterAcceptance')({ ...bound, uri }),
        reopen: () => commands.get('clinical-dsl.monograph.open')() };
}
