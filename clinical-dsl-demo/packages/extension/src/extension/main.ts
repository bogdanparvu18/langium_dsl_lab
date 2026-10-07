import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind, type ServerOptions } from 'vscode-languageclient/node';
import {
    GET_SHOW_PLANS,
    SHOW_PLANS_READY,
    type ShowPlanItem,
    type ShowPlansResponse
} from '../shared/show-plan-protocol.js';

// The only custom VS Code command in this implementation.
const PREVIEW = 'clinical-dsl.showJson.preview';
let client: LanguageClient | undefined;

interface ShowTarget {
    uri: string;
    version: number;
    startOffset: number;
    planName: string;
}

function toRange(item: ShowPlanItem): vscode.Range {
    return new vscode.Range(
        item.range.start.line, item.range.start.character,
        item.range.end.line, item.range.end.character
    );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'main.cjs'));
    const debugOptions = {
        execArgv: ['--nolazy', `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`]
    };
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };
    const languageClient = new LanguageClient(
        'clinical-dsl', 'Clinical DSL', serverOptions,
        { documentSelector: [{ scheme: '*', language: 'clinical-dsl' }] }
    );
    client = languageClient;
    let started = false;
    const refresh = new vscode.EventEmitter<void>();
    context.subscriptions.push(refresh);

    async function query(
        document: vscode.TextDocument,
        cancellation?: vscode.CancellationToken
    ): Promise<ShowPlansResponse | undefined> {
        if (!started || document.languageId !== 'clinical-dsl' || cancellation?.isCancellationRequested) {
            return undefined;
        }
        const version = document.version;
        const source = new vscode.CancellationTokenSource();
        const subscription = cancellation?.onCancellationRequested(() => source.cancel());
        const timer = setTimeout(() => source.cancel(), 4000);
        try {
            const result = await languageClient.sendRequest<ShowPlansResponse | null>(
                GET_SHOW_PLANS, { uri: document.uri.toString(), version }, source.token
            );
            if (!source.token.isCancellationRequested && !document.isClosed &&
                result?.uri === document.uri.toString() && result.version === document.version) {
                return result;
            }
        } catch (error: unknown) {
            if (!source.token.isCancellationRequested) {
                console.warn('[Clinical show JSON]', error);
            }
        } finally {
            clearTimeout(timer);
            subscription?.dispose();
            source.dispose();
        }
        return undefined;
    }

    async function runSafely(action: () => Promise<void>): Promise<void> {
        try {
            await action();
        } catch (error: unknown) {
            await vscode.window.showWarningMessage(
                `Clinical DSL: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    context.subscriptions.push(
        // CodeLens -> this custom command -> the built-in Show Hover command.
        // Moving the selection is a UI action; it does not edit the document.
        vscode.commands.registerCommand(PREVIEW, (target?: ShowTarget) => runSafely(async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !target || editor.document.languageId !== 'clinical-dsl' ||
                editor.document.uri.toString() !== target.uri ||
                editor.document.version !== target.version) {
                throw new Error('Keep the document active and use its refreshed Preview JSON action.');
            }
            const position = editor.document.positionAt(target.startOffset);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
            await vscode.commands.executeCommand('editor.action.showHover');
        })),
        // Mouse hover does NOT execute our PREVIEW command. VS Code calls this provider directly.
        vscode.languages.registerHoverProvider('clinical-dsl', {
            async provideHover(document, position, token) {
                const result = await query(document, token);
                if (token.isCancellationRequested) {
                    return undefined;
                }
                const item = result?.items.find(candidate => toRange(candidate).contains(position));
                if (!item) {
                    return undefined;
                }
                const markdown = new vscode.MarkdownString();
                markdown.isTrusted = false;
                markdown.supportHtml = false;
                markdown.appendText(`show ${item.planName} — JSON preview (read-only)`);
                markdown.appendMarkdown('\n\n');
                if (item.error) {
                    markdown.appendText(item.error);
                } else if (item.json !== undefined) {
                    markdown.appendCodeblock(item.json, 'json');
                } else {
                    return undefined;
                }
                return new vscode.Hover(markdown, toRange(item));
            }
        }),
        // Exactly one action per show statement: no Insert, Update or Remove actions.
        vscode.languages.registerCodeLensProvider('clinical-dsl', {
            onDidChangeCodeLenses: refresh.event,
            async provideCodeLenses(document, token) {
                const result = await query(document, token);
                if (!result || token.isCancellationRequested) {
                    return [];
                }
                return result.items.map(item => {
                    const range = toRange(item);
                    const target: ShowTarget = {
                        uri: result.uri,
                        version: result.version,
                        startOffset: item.startOffset,
                        planName: item.planName
                    };
                    // A CodeLens anchor must stay on one line, even if show spans multiple lines.
                    const anchor = new vscode.Range(range.start, range.start);
                    return new vscode.CodeLens(anchor, {
                        title: 'Preview JSON',
                        command: PREVIEW,
                        arguments: [target]
                    });
                });
            }
        }),
        // Register before start so the first validated-document notification is not lost.
        languageClient.onNotification(SHOW_PLANS_READY, () => refresh.fire())
    );

    await languageClient.start();
    started = true;
    refresh.fire();
}

export async function deactivate(): Promise<void> {
    if (client) {
        await client.stop();
        client = undefined;
    }
}
