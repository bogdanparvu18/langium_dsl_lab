import * as vscode from 'vscode';
import { CstUtils, EmptyFileSystem, GrammarUtils, type AstNode } from 'langium';
import {
    createClinicalDslServices, findProductTarget, normalizeFrequency, isMedication, isPatient, isPlan, isDisplayPlan,
    type Medication, type Model, type Plan
} from 'clinical-dsl-language';

// Local parsing uses the same comment, string and field rules as the editor.
// It performs no workspace linking, file access or RxNorm requests.
let parserServices: ReturnType<typeof createClinicalDslServices> | undefined;
function localParser() {
    parserServices ??= createClinicalDslServices(EmptyFileSystem);
    return parserServices.ClinicalDsl.parser;
}
export function parseClinicalDocumentResult(text: string) {
    return localParser().LangiumParser.parse<Model>(text);
}
export function parseClinicalDocument(text: string): Model {
    return parseClinicalDocumentResult(text).value;
}

const fieldNames = new Set(['dose', 'strength', 'doseform', 'route', 'frequency', 'product', 'rxcui', 'rxnormrelease', 'for', 'prescribe']);

/** The cursor selects an example; completeness is calculated from the whole node. */
function fieldAtCursor(node: AstNode, offset: number): string | undefined {
    if (!node.$cstNode) return undefined;
    const properties = ['name', 'amount', 'unit', 'route', 'frequency', 'productStrength', 'doseForm', 'productName', 'rxcui', 'rxnormRelease', 'patient', 'medication'];
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
        frequency: !!normalizeFrequency(node.frequency ?? ''),
        strength: !!node.productStrength?.trim(),
        doseForm: !!node.doseForm?.trim()
    };
    const missing: string[] = [];
    if (!present.dose) missing.push('dose');
    if (!present.route) missing.push('route');
    if (!present.frequency) missing.push('frequency');
    if (present.strength && !present.doseForm) missing.push('doseForm (required with strength)');
    if (present.doseForm && !present.strength) missing.push('strength (required with doseForm)');
    const binding = node.productName !== undefined || node.rxcui !== undefined || node.rxnormRelease !== undefined ||
        field === 'product' || field === 'rxcui';
    const missingProduct = binding && !node.productName?.trim() &&
        (node.rxnormRelease === undefined || node.productName !== undefined || field === 'product');
    const missingId = binding && !/^[1-9][0-9]{0,19}$/.test(node.rxcui ?? '');
    if (missingProduct) missing.push('product (full RxNorm product name)');
    if (missingId) missing.push('rxcui (selected product ID)');

    const missingExamples: string[] = [];
    if (!present.dose) missingExamples.push('dose 10mg');
    if (!present.route) missingExamples.push('route PO');
    if (!present.frequency) missingExamples.push('frequency BID');
    if (present.strength && !present.doseForm) missingExamples.push('doseForm Oral Tablet');
    if (present.doseForm && !present.strength) missingExamples.push('strength 325mg');
    const bindingExample = 'product "Demo tablet" rxcui "900001" (fictional example)';
    if (missingProduct || missingId) missingExamples.push(bindingExample);
    const completionExample = missingExamples.length ? ` To complete, for example: ${missingExamples.join(', ')}.` : '';
    const selection = `Type a prefix directly after the colon, for example Medication ${node.name || 'DemoMed'}: aspi. Choose a product and press Tab to insert its full RxNorm name and RxCUI. Ctrl+Space opens the list.`;
    let example = selection;
    if (field === 'strength') example = 'Product strength example: strength 325mg; include doseForm too, for example doseForm Oral Tablet.';
    else if (field === 'doseform') example = 'Dose form example: doseForm Oral Tablet or doseForm "Metered Dose Inhaler"; include strength too, for example strength 325mg.';
    else if (field === 'route') example = 'Route example: route PO. Other routes: IV, IM, SC, PR, SL, BUCC.';
    else if (field === 'frequency') example = 'Frequency example: frequency BID. An interval may include an hour range and PRN, for example frequency 4-6H PRN.';
    else if (field === 'dose') example = 'Administered dose example: dose 10mg or 10 mg. Units: mg, mcg, g, ml, puff, unit.';
    else if (['rxcui', 'product', 'rxnormrelease'].includes(field ?? '') && !missingProduct && !missingId) {
        example += ` Example: ${bindingExample}.`;
    }
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
    const model = parseClinicalDocument(text);
    const target = findProductTarget(text, offset, model, localParser());
    if (target?.kind === 'standalone') {
        return 'Type a product prefix on its own line, for example aspi. Choose a product and press Tab. The editor creates a Medication declaration with the full product name and RxCUI, for example Medication Demo: product "Demo tablet" rxcui "900001" (fictional).';
    }
    if (target?.kind === 'bare') return medicationHelp(target.medication, 'product');
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
    return 'Type a prefix such as aspi and press Tab on a product suggestion to create a Medication declaration. You can also start with Medication DemoMed: dose 10mg, route PO, frequency BID.';
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
