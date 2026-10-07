import { DocumentState, GrammarAST, URI } from 'langium';
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import {
    createConnection,
    DiagnosticSeverity,
    ProposedFeatures,
    type CancellationToken
} from 'vscode-languageserver/node';
import {
    createClinicalDslServices,
    isModel,
    type DisplayPlan
} from 'clinical-dsl-language';
import {
    GET_SHOW_PLANS,
    SHOW_PLANS_READY,
    type ShowPlanItem,
    type ShowPlansRequest,
    type ShowPlansResponse
} from '../shared/show-plan-protocol.js';

const connection = createConnection(ProposedFeatures.all);
const { shared, ClinicalDsl } = createClinicalDslServices({ connection, ...NodeFileSystem });

/** Project a resolved plan into plain JSON data; do not serialize AST internals. */
function projectPlan(statement: DisplayPlan) {
    const plan = statement.plan.ref;
    if (!plan) {
        throw new Error(`Cannot resolve plan "${statement.plan.$refText}".`);
    }
    const patient = plan.patient.ref;
    const medication = plan.medication.ref;
    if (!patient || !medication) {
        throw new Error(`Plan "${plan.name}" has an unresolved reference.`);
    }
    const age = Number(patient.age);
    const amount = Number(medication.amount);
    if (!Number.isSafeInteger(age) || !Number.isFinite(amount)) {
        throw new Error(`Plan "${plan.name}" has a value that cannot be represented safely as JSON.`);
    }
    return {
        name: plan.name,
        patient: { name: patient.name, age, condition: patient.condition },
        medication: {
            name: medication.name,
            dose: { amount, unit: medication.unit },
            // Compatible with both the original grammar and the route/frequency patch.
            ...('route' in medication && typeof medication.route === 'string'
                ? { route: medication.route } : {}),
            ...('frequency' in medication && typeof medication.frequency === 'string'
                ? { frequency: medication.frequency } : {})
        }
    };
}

connection.onRequest(
    GET_SHOW_PLANS,
    async (params: ShowPlansRequest, token: CancellationToken): Promise<ShowPlansResponse | null> => {
        const uri = URI.parse(params.uri);
        // Only operate on documents already known to the language server.
        if (!shared.workspace.LangiumDocuments.hasDocument(uri)) {
            return null;
        }
        await shared.workspace.DocumentBuilder.waitUntil(DocumentState.Validated, uri, token);
        if (token.isCancellationRequested) {
            return null;
        }
        // Re-fetch after waiting: updates may have replaced the document.
        const document = shared.workspace.LangiumDocuments.getDocument(uri);
        if (!document || document.state !== DocumentState.Validated ||
            document.textDocument.version !== params.version || !isModel(document.parseResult.value)) {
            return null;
        }
        const errors = (document.diagnostics ?? [])
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`);
        if (document.parseResult.lexerErrors.length || document.parseResult.parserErrors.length) {
            errors.push('The document contains syntax errors. Correct them before taking a snapshot.');
        }
        const items: ShowPlanItem[] = [];
        for (const statement of document.parseResult.value.display) {
            const node = statement.$cstNode;
            if (!node) {
                continue;
            }
            const range = node.range;
            const item: ShowPlanItem = {
                range,
                startOffset: document.textDocument.offsetAt(range.start),
                endOffset: document.textDocument.offsetAt(range.end),
                sourceText: document.textDocument.getText(range),
                planName: statement.plan.$refText
            };
            if (errors.length) {
                item.error = errors.join('\n');
            } else {
                try {
                    item.json = JSON.stringify(projectPlan(statement), null, 2);
                } catch (error: unknown) {
                    item.error = error instanceof Error ? error.message : String(error);
                }
            }
            items.push(item);
        }
        return {
            uri: params.uri,
            version: params.version,
            // The integration instructions add the conventional ML_COMMENT rule.
            blockCommentsSupported: ClinicalDsl.Grammar.rules.some(rule =>
                GrammarAST.isTerminalRule(rule) && rule.hidden && rule.name === 'ML_COMMENT'),
            items
        };
    }
);

// Refresh inline action links after validation, including dependent document updates.
shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Validated, async documents => {
    for (const document of documents) {
        if (isModel(document.parseResult.value)) {
            await connection.sendNotification(SHOW_PLANS_READY, {
                uri: document.textDocument.uri,
                version: document.textDocument.version
            });
        }
    }
});

startLanguageServer(shared);
