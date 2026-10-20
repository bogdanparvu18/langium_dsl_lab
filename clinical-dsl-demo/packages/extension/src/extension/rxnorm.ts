import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';

const CONFIG = 'clinicalDsl.rxnorm';
const RESOLVE = 'clinical-dsl.rxnorm.resolve';
const PASSWORD = 'clinical-dsl.rxnorm.setPassword';

interface Position { line: number; character: number; offset: number }
interface Concept { rxcui: string; display: string; tty: string }
interface Mention {
    id: string;
    orderId: string;
    originalText: string;
    role: string;
    source: { uri: string; start: Position; end: Position; text: string };
}
interface Request {
    document: { uri: string; text: string };
    mentions: Mention[];
}
interface Resolution {
    mention: Mention;
    status: string;
    initialConcept?: Concept | null;
    ingredients: { concept: Concept }[];
    diagnostics: string[];
    candidates?: { concept: Concept }[];
}
interface Report {
    schemaVersion: string;
    terminologyRelease: string;
    terminologyScope: string;
    snapshotFingerprint: string;
    resolutions: Resolution[];
}

export type RxNormPreviewState =
    | { kind: 'notChecked' }
    | { kind: 'pending' }
    | { kind: 'failed' }
    | { kind: 'complete'; report: Report; resolution: Resolution };

export interface RxNormPreviewProvider {
    readonly onDidChange: vscode.Event<void>;
    getPreview(document: vscode.TextDocument, planName: string): RxNormPreviewState;
}

interface Snapshot {
    version: number;
    generation: number;
    state: { kind: 'pending' } | { kind: 'failed' } | { kind: 'complete'; report: Report };
}

function configuration(uri?: vscode.Uri): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG, uri);
}

function passwordKey(config: vscode.WorkspaceConfiguration): string {
    return JSON.stringify([
        CONFIG, config.get('pgHost', '127.0.0.1'), config.get('pgPort', 5432),
        config.get('pgDatabase', 'scala_testing_lab'), config.get('pgUser', 'scala_lab')
    ]);
}

function sbtPath(file: string): string {
    // This argument is parsed by sbt as well as by the application. No shell is used.
    if (/[";\r\n]/.test(file)) throw new Error('The temporary path cannot contain quotes, semicolons or newlines.');
    return `"${file.replace(/\\/g, '/')}"`;
}

function parseJson<T>(text: string): T {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T;
}

function checkReport(text: string, request: Request, release: string): Report {
    const report = parseJson<Report>(text);
    if (report.schemaVersion !== '2' || report.terminologyRelease !== release ||
        typeof report.terminologyScope !== 'string' || typeof report.snapshotFingerprint !== 'string' ||
        !Array.isArray(report.resolutions) || report.resolutions.length !== request.mentions.length) {
        throw new Error('Unexpected Scala report. Check the versions of the bridge and Scala project.');
    }
    const remaining = new Map(request.mentions.map(m => [m.id, m]));
    for (const result of report.resolutions) {
        const expected = remaining.get(result.mention?.id);
        if (!expected || JSON.stringify(result.mention.source) !== JSON.stringify(expected.source) ||
            result.mention.originalText !== expected.originalText || result.mention.role !== expected.role ||
            result.mention.orderId !== expected.orderId ||
            !['resolved', 'unresolved', 'needsClarification', 'invalidRole'].includes(result.status) ||
            !Array.isArray(result.ingredients) || !Array.isArray(result.diagnostics)) {
            throw new Error('Scala returned an inconsistent resolution report.');
        }
        if (result.status === 'resolved' && (!result.initialConcept ||
            !/^\d+$/.test(result.initialConcept.rxcui) ||
            typeof result.initialConcept.display !== 'string' || typeof result.initialConcept.tty !== 'string')) {
            throw new Error('A resolved medication has no valid RxNorm concept.');
        }
        remaining.delete(expected.id);
    }
    return report;
}

/** UI orchestration only. Langium validates/export AST; Scala owns terminology resolution. */
export function registerRxNorm(context: vscode.ExtensionContext): RxNormPreviewProvider {
    const output = vscode.window.createOutputChannel('Clinical DSL RxNorm');
    const diagnostics = vscode.languages.createDiagnosticCollection('clinical-dsl-rxnorm');
    const generations = new Map<string, number>();
    const snapshots = new Map<string, Snapshot>();
    const changed = new vscode.EventEmitter<void>();
    let queue: Promise<void> = Promise.resolve();
    let activeChild: ChildProcess | undefined;
    let disposed = false;

    function invalidate(document: vscode.TextDocument): number {
        const uri = document.uri.toString();
        const next = (generations.get(uri) ?? 0) + 1;
        generations.set(uri, next);
        snapshots.delete(uri);
        diagnostics.delete(document.uri);
        changed.fire();
        return next;
    }

    function runProcess(
        executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
        timeoutMs: number, label: string
    ): Promise<void> {
        output.appendLine(`\n[${label}]`);
        return new Promise((resolve, reject) => {
            const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true });
            activeChild = child;
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
            const clean = (): void => {
                clearTimeout(timer);
                if (activeChild === child) activeChild = undefined;
            };
            child.stdout?.on('data', (chunk: Buffer) => output.append(chunk.toString()));
            child.stderr?.on('data', (chunk: Buffer) => output.append(chunk.toString()));
            child.once('error', error => { clean(); reject(error); });
            child.once('close', code => {
                clean();
                if (timedOut) reject(new Error(`${label}: timeout. See Output > Clinical DSL RxNorm.`));
                else if (code !== 0) reject(new Error(`${label}: exit ${code}. See Output > Clinical DSL RxNorm.`));
                else resolve();
            });
        });
    }

    function schedule(document: vscode.TextDocument, manual: boolean): Promise<void> {
        const generation = invalidate(document);
        const version = document.version;
        const originalText = document.getText();
        const current = (): boolean => !disposed && !document.isClosed && !document.isDirty &&
            document.version === version && generations.get(document.uri.toString()) === generation;
        const publish = (state: Snapshot['state']): void => {
            snapshots.set(document.uri.toString(), { version, generation, state });
            changed.fire();
        };
        publish({ kind: 'pending' });
        const task = queue.then(async () => {
            if (!current()) return;
            let temporary: string | undefined;
            try {
                if (!vscode.workspace.isTrusted) throw new Error('Open the lab in a trusted VS Code workspace.');
                const config = configuration(document.uri);
                const scalaRoot = config.get<string>('scalaRoot', '').trim();
                if (!path.isAbsolute(scalaRoot)) throw new Error('Set clinicalDsl.rxnorm.scalaRoot to the absolute Scala project directory.');
                const release = config.get<string>('release', '2026-10-05');
                if (!/^\d{4}-\d{2}-\d{2}$/.test(release)) throw new Error('The RxNorm release must use yyyy-mm-dd.');
                const password = await context.secrets.get(passwordKey(config)) || process.env.PGPASSWORD;
                if (!password) throw new Error('Run Clinical DSL: Set RxNorm PostgreSQL Password first.');
                const toolsRoot = config.get<string>('toolsRoot', '').trim() || path.join(os.homedir(), 'AuroraLab', 'tools');
                const layout = parseJson<{ javaHome: string; nodeHome: string; sbtHome: string }>(
                    await readFile(path.join(toolsRoot, 'layout.json'), 'utf8')
                );
                for (const dir of [layout.javaHome, layout.nodeHome, layout.sbtHome]) {
                    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Invalid tool directory in layout.json.');
                }
                const java = path.join(layout.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
                const node = path.join(layout.nodeHome, process.platform === 'win32' ? 'node.exe' : 'bin/node');
                const launcher = path.join(layout.sbtHome, 'bin', 'sbt-launch.jar');
                const exporter = path.join(scalaRoot, 'bridge', 'export-ast.mjs');
                const langiumRoot = path.resolve(context.extensionPath, '..', '..');
                for (const file of [java, node, launcher, exporter, path.join(scalaRoot, 'build.sbt'),
                    path.join(langiumRoot, 'packages', 'language', 'out', 'index.js')]) await access(file);
                const host = config.get<string>('pgHost', '127.0.0.1');
                if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('This lab requires a local PostgreSQL host.');
                const timeout = config.get<number>('timeoutSeconds', 300) * 1000;
                const env: NodeJS.ProcessEnv = {
                    ...process.env,
                    JAVA_HOME: layout.javaHome,
                    PGHOST: host, PGPORT: String(config.get<number>('pgPort', 5432)),
                    PGDATABASE: config.get<string>('pgDatabase', 'scala_testing_lab'),
                    PGUSER: config.get<string>('pgUser', 'scala_lab'), PGPASSWORD: password
                };
                await mkdir(context.globalStorageUri.fsPath, { recursive: true });
                temporary = await mkdtemp(path.join(context.globalStorageUri.fsPath, 'rxnorm-'));
                const input = path.join(temporary, 'ast.json');
                const result = path.join(temporary, 'resolved.json');
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Clinical DSL: RxNorm' }, async () => {
                    await runProcess(node, [exporter, '--langium-root', langiumRoot, '--input', document.uri.fsPath,
                        '--release', release, '--output', input], scalaRoot, process.env, timeout, 'Langium AST export');
                    const request = parseJson<Request>(await readFile(input, 'utf8'));
                    if (!current()) return;
                    if (request.document.text !== originalText ||
                        vscode.Uri.parse(request.document.uri).toString() !== document.uri.toString()) {
                        throw new Error('The source file changed during AST export. Save it and run again.');
                    }
                    await runProcess(java, ['-Xmx2G', '-Dsbt.supershell=false', '-Dsbt.log.noformat=true',
                        '-jar', launcher, `run resolve ${sbtPath(input)} ${sbtPath(result)}`],
                    scalaRoot, env, timeout, 'Scala / PostgreSQL resolve');
                    if (!current()) return;
                    const report = checkReport(await readFile(result, 'utf8'), request, release);
                    // The editor can change while the result file is being read.
                    if (!current()) return;
                    const items: vscode.Diagnostic[] = [];
                    const summaries: string[] = [];
                    output.appendLine(`\n${document.uri.fsPath}\nRelease: ${report.terminologyRelease}; scope: ${report.terminologyScope}`);
                    output.appendLine(`Snapshot: ${report.snapshotFingerprint}`);
                    output.appendLine('Text\tRole\tStatus\tRxCUI\tName\tType');
                    for (const resolution of report.resolutions) {
                        const { mention, status, initialConcept: concept } = resolution;
                        const summary = status === 'resolved' && concept
                            ? `${mention.originalText}: RxCUI ${concept.rxcui} | ${concept.display} | ${concept.tty}`
                            : status === 'unresolved' ? `medication unknown: ${mention.originalText}`
                            : `${mention.originalText}: ${status}`;
                        summaries.push(summary);
                        const range = new vscode.Range(mention.source.start.line, mention.source.start.character,
                            mention.source.end.line, mention.source.end.character);
                        const ingredients = resolution.ingredients.map(i => `${i.concept.display} (${i.concept.rxcui}, ${i.concept.tty})`).join(', ');
                        const message = `${summary}\nRole: ${mention.role}; status: ${status}; release: ${release}` +
                            (ingredients ? `\nIngredients: ${ingredients}` : '') +
                            (resolution.diagnostics.length ? `\n${resolution.diagnostics.join('\n')}` : '');
                        const item = new vscode.Diagnostic(range, message,
                            status === 'resolved' ? vscode.DiagnosticSeverity.Information
                                : status === 'unresolved' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
                        item.source = 'RxNorm / Scala';
                        if (status === 'unresolved') item.code = 'MEDICATION_UNKNOWN';
                        items.push(item);
                        output.appendLine([mention.originalText, mention.role, status, concept?.rxcui ?? '-',
                            concept?.display ?? '-', concept?.tty ?? '-'].join('\t'));
                    }
                    diagnostics.set(document.uri, items);
                    publish({ kind: 'complete', report });
                    const summary = [...new Set(summaries)].slice(0, 3).join('; ') +
                        (summaries.length > 3 ? '; see Output for all medications' : '');
                    const show = report.resolutions.every(r => r.status === 'resolved')
                        ? vscode.window.showInformationMessage
                        : report.resolutions.some(r => r.status === 'unresolved')
                            ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
                    void show(`RxNorm: ${summary}`, 'Show details').then(choice => {
                        if (choice) output.show(true);
                    });
                });
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                output.appendLine(`ERROR: ${message}`);
                if (current()) {
                    publish({ kind: 'failed' });
                    if (manual) output.show(true);
                    void vscode.window.showWarningMessage(`RxNorm: ${message}`);
                }
            } finally {
                if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
            }
        });
        // One sbt process at a time; obsolete queued saves are skipped.
        queue = task.catch(error => output.appendLine(String(error)));
        return queue;
    }

    context.subscriptions.push(output, diagnostics, changed,
        vscode.commands.registerCommand(PASSWORD, async () => {
            const config = configuration(vscode.window.activeTextEditor?.document.uri);
            const password = await vscode.window.showInputBox({
                title: 'RxNorm: local PostgreSQL password', password: true, ignoreFocusOut: true,
                prompt: `Password for ${config.get('pgUser', 'scala_lab')} in ${config.get('pgDatabase', 'scala_testing_lab')}`
            });
            if (!password) return;
            await context.secrets.store(passwordKey(config), password);
            void vscode.window.showInformationMessage('RxNorm PostgreSQL password saved in VS Code SecretStorage.');
        }),
        vscode.commands.registerCommand(RESOLVE, async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!document || document.uri.scheme !== 'file' || document.languageId !== 'clinical-dsl') {
                void vscode.window.showWarningMessage('Open a saved .clinical file first.');
                return;
            }
            if (document.isDirty) {
                void vscode.window.showWarningMessage('Save the .clinical file before resolving medications.');
                return;
            }
            await schedule(document, true);
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.uri.scheme === 'file' && document.languageId === 'clinical-dsl' &&
                configuration(document.uri).get<boolean>('onSave', true)) void schedule(document, false);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.contentChanges.length) invalidate(event.document);
        }),
        vscode.workspace.onDidCloseTextDocument(document => { invalidate(document); }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(CONFIG)) {
                diagnostics.clear();
                snapshots.clear();
                for (const key of generations.keys()) generations.set(key, (generations.get(key) ?? 0) + 1);
                changed.fire();
            }
        }),
        new vscode.Disposable(() => { disposed = true; activeChild?.kill(); })
    );

    return {
        onDidChange: changed.event,
        getPreview(document, planName) {
            const uri = document.uri.toString();
            const snapshot = snapshots.get(uri);
            if (disposed || document.isClosed || document.isDirty || !snapshot ||
                snapshot.version !== document.version || snapshot.generation !== generations.get(uri)) {
                return { kind: 'notChecked' };
            }
            if (snapshot.state.kind !== 'complete') return snapshot.state;
            const report = snapshot.state.report;
            const resolutions = report.resolutions.filter(r => r.mention.orderId === planName);
            if (resolutions.length !== 1) return { kind: 'notChecked' };
            return { kind: 'complete', report, resolution: resolutions[0] };
        }
    };
}
