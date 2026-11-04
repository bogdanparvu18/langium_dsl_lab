import * as vscode from 'vscode';
import { CstUtils, EmptyFileSystem, GrammarUtils, type AstNode } from 'langium';
import {
    createClinicalDslServices, isMedication, isPatient, isPlan, isDisplayPlan,
    type Medication, type Model, type Plan
} from 'clinical-dsl-language';

// Parse locally only when help is requested. Reusing the language parser keeps
// comments, quoted values, recovery and field boundaries aligned with the DSL.
// This service performs no workspace linking, file access or RxNorm requests.
let helpServices: ReturnType<typeof createClinicalDslServices> | undefined;
function parseForHelp(text: string): Model {
    helpServices ??= createClinicalDslServices(EmptyFileSystem);
    return helpServices.ClinicalDsl.parser.LangiumParser.parse<Model>(text).value;
}

const fieldNames = new Set(['dose', 'strength', 'doseform', 'route', 'frequency', 'rxcui', 'rxnormrelease', 'for', 'prescribe']);

/** The cursor selects an example; completeness is calculated from the whole node. */
function fieldAtCursor(node: AstNode, offset: number): string | undefined {
    if (!node.$cstNode) return undefined;
    const properties = ['name', 'amount', 'unit', 'route', 'frequency', 'productStrength', 'doseForm', 'rxcui', 'rxnormRelease', 'patient', 'medication'];
    const values = properties.flatMap(property => GrammarUtils.findNodesForProperty(node.$cstNode, property));
    const amounts = GrammarUtils.findNodesForProperty(node.$cstNode, 'amount');
    let field: string | undefined;
    for (const leaf of CstUtils.flattenCst(node.$cstNode)) {
        if (leaf.offset >= offset) break;
        if (leaf.hidden) continue;
        if (amounts.some(amount => amount.offset === leaf.offset)) field = 'dose';
        if (values.some(value => leaf.offset >= value.offset && leaf.end <= value.end)) continue;
        const text = leaf.text.toLowerCase();
        if (text === ',' || text === ':') field = undefined;
        else if (fieldNames.has(text)) field = text;
    }
    return field;
}

/** Examples illustrate syntax only, not medication or dosing advice. */
function medicationHelp(node: Medication, field: string | undefined): string {
    const present = {
        dose: typeof node.amount === 'number' && Number.isFinite(node.amount) && node.amount > 0 &&
            ['mg', 'mcg', 'g', 'ml', 'puff', 'unit'].includes(node.unit ?? ''),
        route: ['PO', 'IV', 'IM', 'SC', 'PR', 'SL', 'BUCC'].includes(node.route ?? ''),
        frequency: ['QD', 'BID', 'TID', 'QID', 'PRN', 'Q4H', 'Q6H', 'Q8H', 'Q12H', 'Q24H'].includes(node.frequency ?? ''),
        strength: !!node.productStrength?.trim(),
        doseForm: !!node.doseForm?.trim()
    };
    const missing: string[] = [];
    if (!present.dose) missing.push('dose');
    if (!present.route) missing.push('route');
    if (!present.frequency) missing.push('frequency');
    if (present.strength && !present.doseForm) missing.push('doseForm (required with strength)');
    if (present.doseForm && !present.strength) missing.push('strength (required with doseForm)');
    if (node.rxcui !== undefined && node.rxnormRelease === undefined) missing.push('rxnormRelease (required with rxcui)');
    if (node.rxnormRelease !== undefined && node.rxcui === undefined) missing.push('rxcui (required with rxnormRelease)');

    const missingExamples: string[] = [];
    if (!present.dose) missingExamples.push('dose 10mg');
    if (!present.route) missingExamples.push('route PO');
    if (!present.frequency) missingExamples.push('frequency BID');
    if (present.strength && !present.doseForm) missingExamples.push('doseForm Oral Tablet');
    if (present.doseForm && !present.strength) missingExamples.push('strength 325mg');
    if (node.rxcui !== undefined && node.rxnormRelease === undefined) missingExamples.push('rxnormRelease "2026-10-05"');
    if (node.rxnormRelease !== undefined && node.rxcui === undefined) missingExamples.push('rxcui "900001" (fictional syntax example; select an actual product from suggestions)');
    const completionExample = missingExamples.length ? ` To complete, for example: ${missingExamples.join(', ')}.` : '';
    let example = 'Examples: dose 10mg, route PO, frequency BID.';
    if (field === 'strength') example = 'Product strength example: strength 325mg; include doseForm too, for example doseForm Oral Tablet.';
    else if (field === 'doseform') example = 'Dose form example: doseForm Oral Tablet or doseForm "Metered Dose Inhaler"; include strength too, for example strength 325mg.';
    else if (field === 'route') example = 'Route example: route PO. Other routes: IV, IM, SC, PR, SL, BUCC.';
    else if (field === 'frequency') example = 'Frequency example: frequency BID. Other values: QD, TID, QID, PRN, Q4H, Q6H, Q8H, Q12H, Q24H.';
    else if (field === 'dose') example = 'Administered dose example: dose 10mg or 10 mg. Units: mg, mcg, g, ml, puff, unit.';
    else if (field === 'rxcui' || field === 'rxnormrelease') example = 'Explicit product binding example: rxcui "900001", rxnormRelease "2026-10-05". The RxCUI here is fictional; select an actual product from suggestions. To search without renaming the alias, type rxcui "aspi", press Ctrl+Space and accept a product with Tab. Both fields are required together and keep the product identity separate from the medication alias and administered dose.';
    if (!node.name) return 'Medication NAME: ... — for example, Medication DemoMed: dose 10mg, route PO, frequency BID. Examples are for syntax only.';
    return `${missing.length ? `Missing or incomplete: ${missing.join(', ')}. ` : 'Required medication fields are present. '}${example}${completionExample} Fields may be reordered. See Problems for validation errors. Examples are for syntax only.`;
}

function planHelp(node: Plan, field: string | undefined, model: Model): string {
    const patient = model.patient.find(candidate => candidate.name)?.name ?? 'DemoPatient';
    const medication = model.medication.find(candidate => candidate.name)?.name ?? 'DemoMed';
    const missing: string[] = [];
    if (!node.patient?.$refText) missing.push('for PATIENT');
    if (!node.medication?.$refText) missing.push('prescribe MEDICATION');
    const missingExamples: string[] = [];
    if (!node.patient?.$refText) missingExamples.push(`for ${patient}`);
    if (!node.medication?.$refText) missingExamples.push(`prescribe ${medication}`);
    const completionExample = missingExamples.length ? ` To complete, for example: ${missingExamples.join(', ')}.` : '';
    let example = `Example: for ${patient}, prescribe ${medication}.`;
    if (field === 'for') example = `Patient reference example: for ${patient}.`;
    else if (field === 'prescribe') example = `Medication reference example: prescribe ${medication}.`;
    if (!node.name) return `Plan NAME: ... — for example, Plan DemoPlan: for ${patient}, prescribe ${medication}. Refer to declared names.`;
    return `${missing.length ? `Missing or incomplete: ${missing.join(', ')}. ` : 'Required plan fields are present. '}${example}${completionExample} Use names declared in the document; fields may be reordered. See Problems for unresolved references or other validation errors.`;
}

export function contextHelpMessage(text: string, offset: number): string {
    const model = parseForHelp(text);
    const declarations: AstNode[] = [...model.patient, ...model.medication, ...model.plan, ...model.display]
        .filter(node => node.$cstNode).sort((a, b) => a.$cstNode!.offset - b.$cstNode!.offset);
    // The AST supplies the entire declaration, including suffix fields and
    // continuation lines. Its start selects the context without scanning comments.
    const node = declarations.filter(candidate => candidate.$cstNode!.offset <= offset).at(-1);
    const field = node ? fieldAtCursor(node, offset) : undefined;
    if (isMedication(node)) return medicationHelp(node, field);
    if (isPlan(node)) return planHelp(node, field, model);
    if (isPatient(node)) return 'Patient NAME: age NUMBER, condition IDENTIFIER';
    if (isDisplayPlan(node)) return 'show PLAN — selects a plan for JSON preview and RxNorm export.';
    return 'Start with Medication DemoMed: dose 10mg, route PO, frequency BID. Examples are for syntax only.';
}

/** The key binding consumes ? before it reaches the document or language server. */
export function registerContextHelp(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('clinical-dsl.contextHelp', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'clinical-dsl') return;
        const position = editor.selection.active;
        const document = editor.document;
        const version = document.version;
        const message = contextHelpMessage(document.getText(), document.offsetAt(position));
        const choice = await vscode.window.showInformationMessage(message, 'Show suggestions');
        if (choice && vscode.window.activeTextEditor === editor && document.version === version && editor.selection.active.isEqual(position)) {
            await vscode.commands.executeCommand('editor.action.triggerSuggest');
        }
    }));
}
