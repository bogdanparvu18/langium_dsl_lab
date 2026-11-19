import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { searchOptions } from 'clinical-dsl-language';
import { bindingAt, regimenEdits, validDraftDose, validDraftFrequency } from './regimen-edits.js';

interface Acceptance {
    uri: string;
    alias: string;
    rxcui: string;
    display: string;
    release: string;
}

interface CanadianProduct {
    din: string;
    brandName: string;
    ingredients: string[];
    forms: string[];
    routes: string[];
}

interface RegimenSuggestion {
    dose: string;
    frequency: string;
    page: number;
    context: string;
    evidence: string;
}

function regimenSuggestion(value: unknown): value is RegimenSuggestion {
    if (!record(value)) return false;
    return typeof value.dose === 'string' && validDraftDose(value.dose) &&
        typeof value.frequency === 'string' && validDraftFrequency(value.frequency) &&
        typeof value.page === 'number' && Number.isSafeInteger(value.page) && value.page > 0 &&
        typeof value.context === 'string' && !!value.context.trim() &&
        typeof value.evidence === 'string' && !!value.evidence.trim();
}

async function fillRegimen(editor: vscode.TextEditor, binding: Parameters<typeof regimenEdits>[1],
    version: number, suggestions: unknown, routes: readonly string[]): Promise<{ applied?: RegimenSuggestion, note?: string }> {
    // Older Scala services can still open their PDF without supplying any drafts.
    if (suggestions === undefined) return {};
    if (!Array.isArray(suggestions) || suggestions.length !== 1 || !regimenSuggestion(suggestions[0])) {
        return { note: 'No unambiguous dose and frequency could be extracted for this presentation. Review the PDF for dosing.' };
    }
    const draft = suggestions[0];
    const document = editor.document;
    // Even when the RxNorm binding survives an edit, the clinician may have just
    // removed or changed a dosing field while the PDF was downloading.
    if (document.version !== version) return { note: 'The document changed during lookup. Your fields were preserved.' };
    const edits = regimenEdits(document.getText(), binding, draft.dose, draft.frequency, routes);
    if (!edits) return { note: 'The monograph pair could not be added alongside the existing Medication fields.' };
    if (!edits.length) return { note: 'The existing dose and frequency were kept. Review them for the selected product.' };
    const success = await editor.edit(builder => {
        for (const edit of edits) {
            builder.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
        }
    });
    return success ? { applied: draft } : { note: 'The editor could not apply the draft. You can review the source PDF.' };
}

function candidate(value: unknown): value is CanadianProduct {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<CanadianProduct>;
    return typeof item.din === 'string' && /^\d{8}$/.test(item.din) &&
        typeof item.brandName === 'string' && item.brandName.trim().length > 0 &&
        [item.ingredients, item.forms, item.routes].every(list =>
            Array.isArray(list) && list.every(text => typeof text === 'string'));
}

function signedPdfUrl(origin: string, path: unknown, digest: unknown, selection: URLSearchParams): URL {
    if (typeof path !== 'string' || !path.startsWith('/monograph.pdf?') ||
        typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid cached PDF link.');
    const pdf = new URL(path, origin);
    const query = pdf.searchParams;
    if (pdf.origin !== origin || pdf.pathname !== '/monograph.pdf' || pdf.hash || query.size !== 5 ||
        query.get('sha256') !== digest || !/^[a-f0-9]{64}$/.test(query.get('token') ?? '') ||
        [...selection].some(([key, value]) => query.get(key) !== value)) throw new Error('Invalid cached PDF link.');
    return pdf;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function json(url: URL, method: 'GET' | 'POST', signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(url, { method, signal, redirect: 'error',
        headers: { Accept: 'application/json', 'X-Aurora-Client': 'vscode' } });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = record(body) && typeof body.message === 'string' ? body.message.slice(0, 350) : response.statusText;
        throw new Error(`Scala service returned HTTP ${response.status}: ${detail}`);
    }
    const body = await response.json();
    if (!record(body)) throw new Error('Invalid Scala service response.');
    return body;
}

/** This command runs after native completion applies its edits, or explicitly from the palette. */
export function registerMonographs(context: vscode.ExtensionContext): void {
    let previous: vscode.CancellationTokenSource | undefined;

    async function open(expected?: Acceptance): Promise<void> {
        previous?.cancel();
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'clinical-dsl' || !vscode.workspace.isTrusted) return;
        const document = editor.document;
        const uri = document.uri.toString();
        const config = vscode.workspace.getConfiguration('clinicalDsl.rxnorm', document.uri);
        const options = searchOptions({ enabled: true, url: config.get('searchUrl', 'http://127.0.0.1:8765'),
            release: config.get('release', '2026-10-05') });
        if (!options) {
            await vscode.window.showWarningMessage('Configure a local RxNorm search URL and release to open a monograph.');
            return;
        }
        if (expected && (expected.uri !== uri || expected.release !== options.release)) return;
        const bound = bindingAt(document.getText(), expected?.alias ?? document.offsetAt(editor.selection.active), options.release);
        if (!bound) {
            if (!expected) await vscode.window.showInformationMessage('Place the cursor in a Medication declaration with a selected RxNorm product from the configured release.');
            return;
        }
        const { alias, rxcui } = bound;
        if (expected && (rxcui !== expected.rxcui || bound.display !== expected.display)) return;
        const initialVersion = document.version;
        let version = initialVersion;
        const cancellation = new vscode.CancellationTokenSource();
        previous = cancellation;
        const current = () => {
            if (cancellation.token.isCancellationRequested || !vscode.workspace.isTrusted || document.isClosed || vscode.window.activeTextEditor !== editor) return false;
            if (document.version === version) return true;
            // The download can outlive edits to dose, frequency or a separate declaration.
            const updated = bindingAt(document.getText(), alias, options.release);
            if (updated?.rxcui !== rxcui || updated.display !== bound.display) return false;
            version = document.version;
            return true;
        };
        const subscriptions = [
            vscode.window.onDidChangeActiveTextEditor(active => { if (editor !== active) cancellation.cancel(); }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('clinicalDsl.rxnorm', document.uri)) cancellation.cancel();
            })
        ];
        const abort = new AbortController();
        subscriptions.push(cancellation.token.onCancellationRequested(() => abort.abort()));
        const params = new URLSearchParams({ release: options.release, rxcui });
        try {
            const lookup = new URL('/canadian-products', options.url);
            lookup.search = params.toString();
            const result = await json(lookup, 'GET', AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]));
            if (!current()) return;
            const display = result.rxnormDisplay;
            if (result.release !== options.release || result.rxcui !== rxcui || typeof display !== 'string' ||
                !display || (bound.display !== undefined && bound.display !== display)) {
                throw new Error('The saved product name or RxNorm release has changed. Select the product again.');
            }
            if (!Array.isArray(result.items) || !result.items.every(candidate)) throw new Error('Invalid Canadian catalog response.');
            const items: CanadianProduct[] = result.items;
            if (!items.length) {
                await vscode.window.showInformationMessage(`No matching Canadian product was found for ${display}.`);
                return;
            }
            const selectionKey = 'clinical-dsl.din.' + createHash('sha256').update(
                JSON.stringify([uri, alias, options.url, options.release, rxcui, display])).digest('hex');
            const saved = document.isUntitled ? undefined : context.workspaceState.get<string>(selectionKey);
            const remembered = items.find(item => item.din === saved);
            let choice = (expected || items.length === 1) ? remembered : undefined;
            if (!choice) {
                const choices = items.map(item => ({
                    label: item.brandName,
                    description: 'DIN ' + item.din + (item === remembered ? ' (previously selected)' : ''),
                    detail: [...item.ingredients, ...item.forms, ...item.routes].join(' · '),
                    item
                }));
                const picked = await vscode.window.showQuickPick(choices, {
                    title: `Select the Canadian product for ${display}`, matchOnDescription: true, matchOnDetail: true
                }, cancellation.token);
                if (!picked || !current()) return;
                choice = picked.item;
            }
            if (!document.isUntitled && saved !== choice.din) {
                // Remember the clinician's product selection even if Health Canada is offline.
                await context.workspaceState.update(selectionKey, choice.din);
                if (!current()) return;
            }
            params.set('din', choice.din);
            const resolve = new URL('/monograph', options.url);
            resolve.search = params.toString();
            const info = await json(resolve, 'POST', AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]));
            if (!current()) return;
            if (info.status === 'unavailable') {
                await vscode.window.showInformationMessage(`Health Canada has no electronic monograph for ${choice.brandName} (DIN ${choice.din}).`);
                return;
            }
            if (info.status !== 'available') throw new Error('Invalid monograph response.');
            const pdf = signedPdfUrl(options.url, info.pdfPath, info.sha256, params);
            const dosagePage = typeof info.dosagePage === 'number' && Number.isSafeInteger(info.dosagePage) && info.dosagePage > 0
                ? info.dosagePage : undefined;
            const { applied, note } = await fillRegimen(editor, { ...bound, release: options.release }, initialVersion, info.regimenSuggestions, choice.routes);
            if (!current()) return;
            const revision = typeof info.revision === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(info.revision)
                ? `, revised ${info.revision}` : '';
            const product = `${choice.brandName} (DIN ${choice.din}${revision})`;
            const page = applied?.page ?? dosagePage;
            const button = page ? 'Open dosage section' : 'Open PDF';
            if (applied) {
                const evidenceAction = 'Read source passage';
                const message = `Editable dose and frequency for ${alias}: ${applied.dose}, ${applied.frequency}. ` +
                    `Health Canada monograph for ${product}, PDF p. ${page}. ${applied.context}. ${applied.evidence}`;
                const action = await vscode.window.showInformationMessage(message, button, evidenceAction);
                if (!current()) return;
                if (action === evidenceAction) {
                    const openPdf = await vscode.window.showInformationMessage(`Source passage for ${product}, PDF p. ${page}`,
                        { modal: true, detail: applied.context + '\n\n' + applied.evidence }, button);
                    if (openPdf !== button || !current()) return;
                } else if (action !== button) return;
            } else if (expected) {
                const action = await vscode.window.showInformationMessage(
                    `Health Canada monograph for ${product}.` + (note ? ' ' + note : ''), button);
                if (action !== button || !current()) return;
            }
            // openExternal forwards a remote loopback URL to the browser. The preview
            // token permits a rewritten Host for this exact cached document.
            if (page) pdf.hash = 'page=' + page;
            if (!await vscode.env.openExternal(vscode.Uri.parse(pdf.toString()))) throw new Error('Unable to open the cached PDF.');
        } catch (error) {
            if (current()) await vscode.window.showWarningMessage('Health Canada monograph: ' +
                (error instanceof Error ? error.message : String(error)) + ' Retry with Open Health Canada Product Monograph.');
        } finally {
            if (previous === cancellation) previous = undefined;
            subscriptions.forEach(subscription => subscription.dispose());
            cancellation.dispose();
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('clinical-dsl.monograph.afterAcceptance', (expected: Acceptance) =>
            expected && open(expected)),
        vscode.commands.registerCommand('clinical-dsl.monograph.open', () => open()),
        { dispose: () => previous?.cancel() }
    );
}
