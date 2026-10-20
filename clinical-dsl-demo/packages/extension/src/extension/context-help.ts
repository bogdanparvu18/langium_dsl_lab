import * as vscode from 'vscode';

/** The key binding consumes ? before it reaches the document or language server. */
export function registerContextHelp(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('clinical-dsl.contextHelp', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'clinical-dsl') return;
        const position = editor.selection.active;
        const prefix = editor.document.lineAt(position.line).text.slice(0, position.character);
        let message = 'Start with Medication NAME: DOSE UNIT, strength VALUE, doseForm FORM, route ROUTE, frequency FREQUENCY';
        if (/^\s*medication\s+[^:]*$/i.test(prefix)) message = 'Enter a medication identifier, then : (for example aspirin:). Names currently use letters, digits and underscores.';
        else if (/^\s*medication\s+\w+:[^,]*$/i.test(prefix)) message = 'Enter the administered dose: positive number followed by mg, mcg, g, ml, puff or unit. Then type a comma. This is separate from product strength.';
        else if (/[,]\s*strength\b[^,]*$/i.test(prefix)) message = 'Enter product strength without quotes, for example 325 mg or 160 mg/5 ml. Then add , doseForm and the form.';
        else if (/[,]\s*doseForm\b[^,]*$/i.test(prefix)) message = 'Enter the dose form without quotes, for example Oral Tablet. Then add , route. Strength and doseForm must be supplied together.';
        else if (/[,]\s*route\b[^,]*$/i.test(prefix)) message = 'Route: PO, IV, IM, SC, PR, SL or BUCC. Then add , frequency.';
        else if (/[,]\s*frequency\b[^,]*$/i.test(prefix)) message = 'Frequency: QD, BID, TID, QID, PRN, Q4H, Q6H, Q8H, Q12H or Q24H. This completes the declaration.';
        else if (/^\s*patient\b/i.test(prefix)) message = 'Patient NAME: age NUMBER, condition IDENTIFIER';
        else if (/^\s*plan\b/i.test(prefix)) message = 'Plan NAME: for PATIENT, prescribe MEDICATION';
        else if (/^\s*show\b/i.test(prefix)) message = 'show PLAN — selects a plan for JSON preview and RxNorm export.';
        const document = editor.document;
        const version = document.version;
        const choice = await vscode.window.showInformationMessage(message, 'Show suggestions');
        if (choice && vscode.window.activeTextEditor === editor && document.version === version && editor.selection.active.isEqual(position)) {
            await vscode.commands.executeCommand('editor.action.triggerSuggest');
        }
    }));
}
