import * as vscode from 'vscode';

/** Examples illustrate syntax only, not medication or dosing advice. */
function medicationHelp(prefix: string): string {
    const colon = prefix.indexOf(':');
    if (colon < 0) {
        return 'Medication NAME: ... — for example, Medication DemoMed: dose 10mg, route PO, frequency BID. Examples are for syntax only.';
    }
    const fields = prefix.slice(colon + 1)
        .replace(/(^|[\s,]+)(?=(?:doseForm|dose|strength|route|frequency)\b)/gi, ',')
        .split(',').map(field => field.trim()).filter(Boolean);
    const present = {
        dose: fields.some(field => !/^(?:strength|doseForm)\b/i.test(field) && /(?:^|\s)(?:dose\s+)?\d+(?:\.\d+)?\s*(?:mcg|mg|g|ml|puff|unit)(?=\s|$)/i.test(field)),
        route: fields.some(field => /^route\s+(?:PO|IV|IM|SC|PR|SL|BUCC)(?=\s|$)/i.test(field)),
        frequency: fields.some(field => /^frequency\s+(?:QD|BID|TID|QID|PRN|Q4H|Q6H|Q8H|Q12H|Q24H)(?=\s|$)/i.test(field)),
        strength: fields.some(field => /^strength\s+\S/i.test(field)),
        doseForm: fields.some(field => /^doseForm\s+\S/i.test(field))
    };
    const missing: string[] = [];
    if (!present.dose) missing.push('dose');
    if (!present.route) missing.push('route');
    if (!present.frequency) missing.push('frequency');
    if (present.strength && !present.doseForm) missing.push('doseForm (required with strength)');
    if (present.doseForm && !present.strength) missing.push('strength (required with doseForm)');

    const current = /,\s*$/.test(prefix) ? '' : fields[fields.length - 1] ?? '';
    let example = 'Examples: dose 10mg, route PO, frequency BID.';
    if (/^strength\b/i.test(current)) example = 'Product strength example: strength 325mg; include doseForm too, for example doseForm Oral Tablet.';
    else if (/^doseForm\b/i.test(current)) example = 'Dose form example: doseForm Oral Tablet; include strength too, for example strength 325mg.';
    else if (/^route\b/i.test(current)) example = 'Route example: route PO. Other routes: IV, IM, SC, PR, SL, BUCC.';
    else if (/^frequency\b/i.test(current)) example = 'Frequency example: frequency BID. Other values: QD, TID, QID, PRN, Q4H, Q6H, Q8H, Q12H, Q24H.';
    else if (/^(?:dose\b|\d)/i.test(current)) example = 'Administered dose example: dose 10mg or 10 mg. Units: mg, mcg, g, ml, puff, unit.';

    return `${missing.length ? `Missing or incomplete: ${missing.join(', ')}. ` : 'Required medication fields are present. '}${example} Fields may be reordered. Examples are for syntax only.`;
}

function planHelp(prefix: string): string {
    const colon = prefix.indexOf(':');
    if (colon < 0) return 'Plan NAME: ... — for example, Plan DemoPlan: for DemoPatient, prescribe DemoMed. Refer to declared names.';
    const fields = prefix.slice(colon + 1)
        .replace(/(^|[\s,]+)(?=(?:for|prescribe)\b)/gi, ',')
        .split(',').map(field => field.trim()).filter(Boolean);
    const missing: string[] = [];
    if (!fields.some(field => /^for\s+[_a-zA-Z]\w*\s*$/i.test(field))) missing.push('for PATIENT');
    if (!fields.some(field => /^prescribe\s+[_a-zA-Z]\w*\s*$/i.test(field))) missing.push('prescribe MEDICATION');
    const current = /,\s*$/.test(prefix) ? '' : fields[fields.length - 1] ?? '';
    let example = 'Example: for DemoPatient, prescribe DemoMed.';
    if (/^for\b/i.test(current)) example = 'Patient reference example: for DemoPatient.';
    else if (/^prescribe\b/i.test(current)) example = 'Medication reference example: prescribe DemoMed.';
    return `${missing.length ? `Missing or incomplete: ${missing.join(', ')}. ` : 'Required plan fields are present. '}${example} Use names declared in the document; fields may be reordered.`;
}

/** The key binding consumes ? before it reaches the document or language server. */
export function registerContextHelp(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('clinical-dsl.contextHelp', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'clinical-dsl') return;
        const position = editor.selection.active;
        let prefix = editor.document.lineAt(position.line).text.slice(0, position.character);
        // Colon declarations may span lines. Look backwards only as far as the
        // enclosing declaration rather than treating a continuation as a new one.
        for (let line = position.line - 1;
            line >= 0 && line >= position.line - 100 && !/^\s*(?:patient|medication|plan|show)\b/i.test(prefix);
            line--) {
            prefix = `${editor.document.lineAt(line).text}\n${prefix}`;
        }
        let message = 'Start with Medication DemoMed: dose 10mg, route PO, frequency BID. Examples are for syntax only.';
        if (/^\s*medication\b/i.test(prefix)) message = medicationHelp(prefix);
        else if (/^\s*patient\b/i.test(prefix)) message = 'Patient NAME: age NUMBER, condition IDENTIFIER';
        else if (/^\s*plan\b/i.test(prefix)) message = planHelp(prefix);
        else if (/^\s*show\b/i.test(prefix)) message = 'show PLAN — selects a plan for JSON preview and RxNorm export.';
        const document = editor.document;
        const version = document.version;
        const choice = await vscode.window.showInformationMessage(message, 'Show suggestions');
        if (choice && vscode.window.activeTextEditor === editor && document.version === version && editor.selection.active.isEqual(position)) {
            await vscode.commands.executeCommand('editor.action.triggerSuggest');
        }
    }));
}
