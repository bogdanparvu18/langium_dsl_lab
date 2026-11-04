import { AstUtils, CstUtils, GrammarAST, GrammarUtils, type AstNode, type CstNode, type LangiumDocument, type MaybePromise } from 'langium';
import {
    DefaultCompletionProvider,
    type CompletionAcceptor,
    type CompletionContext,
    type LangiumServices,
    type NextFeature
} from 'langium/lsp';

import { DEMO_AMOUNT_OPTIONS } from './clinical-dsl-presets.js';
import { isMedication, isPlan } from './generated/ast.js';
import { CancellationTokenSource, CompletionItemKind, type CancellationToken, type CompletionParams, type CompletionList, type Connection, type InitializeParams } from 'vscode-languageserver';
import { RxNormProductSearch, searchOptions } from './rxnorm-product-search.js';
import { productCompletion } from './rxnorm-product-completion.js';

/** Fictional items for testing the editor, NOT a clinical formulary. */
const MEDICATION_CATALOG: ReadonlyArray<{
    name: string;
    description: string;
}> = [
    { name: 'DemoMedA', description: 'Fictional medication A for syntax testing.' },
    { name: 'DemoMedB', description: 'Fictional medication B for syntax testing.' },
    { name: 'DemoMedC', description: 'Fictional medication C for syntax testing.' }
];

/** Adds name suggestions, preserving Langium keyword/reference completion. */
export class ClinicalDslCompletionProvider extends DefaultCompletionProvider {
    private readonly productSearch = new RxNormProductSearch();
    private readonly connection?: Connection;
    private readonly documents;
    private rxnormOptions: unknown;
    private resourceConfiguration = false;
    private configurationEpoch = 0;
    private sequence = 0;
    private readonly requests = new Map<string, number>();
    private readonly pending = new Map<string, CancellationTokenSource>();

    constructor(services: LangiumServices) {
        super(services);
        this.connection = services.shared.lsp.Connection;
        this.documents = services.shared.workspace.LangiumDocuments;
        this.connection?.onNotification('clinical-dsl/configureRxNormSearch', options => this.configureRxNorm(options));
        // Langium completion holds a workspace read lock. Release a pending HTTP
        // search immediately when ANY document needs rebuilding under its write lock.
        const cancelPending = () => { for (const source of this.pending.values()) source.cancel(); };
        services.shared.workspace.TextDocuments.onDidChangeContent(cancelPending);
        services.shared.workspace.TextDocuments.onDidOpen(cancelPending);
        services.shared.workspace.TextDocuments.onDidClose(cancelPending);
    }

    protected override initialize(params: InitializeParams): void {
        super.initialize(params);
        this.resourceConfiguration = params.capabilities.workspace?.configuration === true;
        this.configureRxNorm(params.initializationOptions?.rxnormSearch);
    }

    configureRxNorm(options: unknown): void {
        this.rxnormOptions = options;
        this.configurationEpoch++;
        this.productSearch.clear();
        for (const source of this.pending.values()) source.cancel();
    }

    override async getCompletion(document: LangiumDocument, params: CompletionParams, cancelToken?: CancellationToken): Promise<CompletionList | undefined> {
        const uri = document.uri.toString();
        const request = ++this.sequence;
        const epoch = this.configurationEpoch;
        const version = document.textDocument.version;
        this.pending.get(uri)?.cancel();
        const cancellation = new CancellationTokenSource();
        const subscription = cancelToken?.onCancellationRequested(() => cancellation.cancel());
        if (cancelToken?.isCancellationRequested) cancellation.cancel();
        this.pending.set(uri, cancellation);
        this.requests.set(uri, request);
        const current = () => !cancellation.token.isCancellationRequested && this.requests.get(uri) === request &&
            this.configurationEpoch === epoch && document.textDocument.version === version &&
            (this.documents.getDocument(document.uri)?.textDocument.version ?? version) === version;
        try {
            const result = await this.getSyntaxCompletion(document, params, cancellation.token);
            if (!result || !current()) return undefined;
            const offset = document.textDocument.offsetAt(params.position);
            const medication = AstUtils.streamContents(document.parseResult.value).filter(isMedication).find(node => {
                const name = node.$cstNode && GrammarUtils.findNodesForProperty(node.$cstNode, 'name')[0];
                const binding = node.$cstNode && GrammarUtils.findNodesForProperty(node.$cstNode, 'rxcui')[0];
                return (name && name.offset <= offset && offset <= name.end) ||
                    (binding && binding.offset < offset && offset < binding.end);
            });
            if (!medication?.$cstNode) return result;
            const name = GrammarUtils.findNodesForProperty(medication.$cstNode, 'name')[0];
            if (!name || typeof medication.name !== 'string') return result;
            const bindingValue = GrammarUtils.findNodesForProperty(medication.$cstNode, 'rxcui').find(node => node.offset < offset && offset < node.end);
            const prefix = document.textDocument.getText().slice(bindingValue ? bindingValue.offset + 1 : name.offset, offset);
            // Re-request as a prefix grows, including after an empty/too-short result.
            result.isIncomplete = true;
            if (prefix.length < 2) return result;
            let configured = this.rxnormOptions;
            if (this.resourceConfiguration && this.connection) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                let listener: { dispose(): void } | undefined;
                try {
                    // A client configuration RPC must not hold the workspace lock
                    // after a document edit, even when that client is unresponsive.
                    const settings = await Promise.race([
                        this.connection.workspace.getConfiguration({ scopeUri: uri, section: 'clinicalDsl.rxnorm' }),
                        new Promise<undefined>(resolve => {
                            timer = setTimeout(() => resolve(undefined), 1000);
                            listener = cancellation.token.onCancellationRequested(() => resolve(undefined));
                            if (cancellation.token.isCancellationRequested) resolve(undefined);
                        })
                    ]);
                    if (!current()) return undefined;
                    if (!settings) return result;
                    configured = { enabled: settings?.searchEnabled, url: settings?.searchUrl, release: settings?.release };
                } catch { return current() ? result : undefined; }
                finally { if (timer) clearTimeout(timer); listener?.dispose(); }
            }
            const options = searchOptions(configured);
            if (!options || !current()) return result;
            const products = await this.productSearch.search(prefix, options, cancellation.token);
            if (!current()) return undefined;
            const items = products.items.flatMap((product, index) => {
                const item = productCompletion(document, medication, name, product, prefix, index, bindingValue);
                return item ? [item] : [];
            });
            return { ...result, items: [...items, ...result.items] };
        } finally {
            if (this.requests.get(uri) === request) this.requests.delete(uri);
            if (this.pending.get(uri) === cancellation) this.pending.delete(uri);
            subscription?.dispose();
            cancellation.dispose();
        }
    }

    private async getSyntaxCompletion(document: LangiumDocument, params: CompletionParams, cancelToken?: CancellationToken): Promise<CompletionList | undefined> {
        const result = await super.getCompletion(document, params, cancelToken);
        if (!result) return result;
        const offset = document.textDocument.offsetAt(params.position);
        const declarations = AstUtils.streamContents(document.parseResult.value)
            .filter(node => !!node.$cstNode).toArray().sort((a, b) => a.$cstNode!.offset - b.$cstNode!.offset);
        const declaration = declarations.filter(node => node.$cstNode!.offset <= offset).at(-1);
        if (!declaration || !isPlan(declaration) || !declaration.$cstNode) return result;
        const cst = declaration.$cstNode;
        const lexed = this.lexer.tokenize(document.textDocument.getText());
        const insideComment = lexed.hidden.some(token => token.startOffset <= offset &&
            (token.tokenType.name === 'SL_COMMENT' ? offset <= token.endOffset! + 1 :
                token.tokenType.name === 'ML_COMMENT' && offset < token.endOffset! + 1));
        const insideString = lexed.tokens.some(token => token.tokenType.name === 'STRING' &&
            token.startOffset < offset && offset < token.endOffset! + 1);
        if (insideComment || insideString) return { ...result, items: [] };
        const left = document.textDocument.getText().slice(cst.offset, offset);
        // Langium's unordered-group completion can skip the remaining Plan field.
        // Fill that gap only at a field boundary, never inside a reference value.
        const fragment = /[A-Za-z_]\w*$/.exec(left)?.[0] ?? '';
        const tokenStart = offset - fragment.length;
        const previous = CstUtils.flattenCst(cst).filter(node => !node.hidden && node.end <= tokenStart).toArray().at(-1);
        const propertyNodes = ['patient', 'medication'].flatMap(property => GrammarUtils.findNodesForProperty(cst, property));
        const boundary = previous && (previous.text === ':' || previous.text === ',' ||
            propertyNodes.some(node => node.end === previous.end));
        if (!boundary) return result;
        const keywords = [['for', 'patient'], ['prescribe', 'medication']] as const;
        const missing = keywords.filter(([keyword, property]) =>
            keyword.startsWith(fragment.toLowerCase()) && !GrammarUtils.findNodesForProperty(cst, property).some(node => node.length > 0));
        if (!missing.length) return result;
        result.items = result.items.filter(item => !['patient', 'Patient', 'medication', 'plan', 'show'].includes(item.label));
        for (const [keyword] of missing) {
            if (!result.items.some(item => item.label === keyword)) result.items.push({
                label: keyword,
                kind: CompletionItemKind.Keyword,
                textEdit: {range: {start: document.textDocument.positionAt(tokenStart), end: params.position}, newText: keyword}
            });
        }
        return result;
    }

    protected override completionFor(
        context: CompletionContext,
        next: NextFeature,
        acceptor: CompletionAcceptor
    ): MaybePromise<void> {
        const assignment = AstUtils.getContainerOfType(
            next.feature, GrammarAST.isAssignment
        );
        const rule = AstUtils.getContainerOfType(
            next.feature, GrammarAST.isParserRule
        );


        const property = this.fieldProperty(next.feature, rule, assignment);
        if (property && this.hasOtherOccurrence(context, property, next.feature)) {
            return;
        }

        if (GrammarAST.isRuleCall(next.feature) && rule?.name === 'DoseAmount') {
            DEMO_AMOUNT_OPTIONS.forEach((amount, index) => {
                const text = String(amount);
                acceptor(context, {
                    label: text,
                    insertText: text,
                    detail: 'Prototype amount — select a unit next',
                    documentation: 'Fictional test value. Not a patient-specific dose recommendation.',
                    sortText: String(index).padStart(3, '0'),
                    preselect: false
                });
            });
            return;
        }

        // Restrict the catalog to the declaration's `Medication.name=Identifier`.
        // Other name declarations and cross-references keep their normal behavior.
        if (
            GrammarAST.isRuleCall(next.feature) &&
            ['ID', 'Identifier'].includes(next.feature.rule.ref?.name ?? '') &&
            assignment?.feature === 'name' &&
            rule?.name === 'Medication'
        ) {
            for (const item of MEDICATION_CATALOG) {
                acceptor(context, {
                    label: item.name,
                    insertText: item.name,
                    detail: 'Demo catalog — not prescribing advice',
                    documentation: item.description +
                        '\nEnter the quantity, unit, route, and frequency explicitly.',
                    sortText: item.name
                });
            }
            return;
        }

        return super.completionFor(context, next, acceptor);
    }

    /** Suppress a field already present elsewhere, including after the cursor. */
    protected hasOtherOccurrence(context: CompletionContext, property: string, feature: GrammarAST.AbstractElement): boolean {
        const declaration = context.node && AstUtils.getContainerOfType(context.node,
            (node: AstNode) => isMedication(node) || isPlan(node));
        const cst = declaration?.$cstNode;
        if (!cst) return false;
        const occurrences = GrammarUtils.findNodesForProperty(cst, property);
        if (!occurrences.length) return false;

        // Replacing a value in an existing field is permitted. Completion of the
        // next (empty) token is not a replacement, even when it touches its end.
        const overlapsReplacement = (node: CstNode) => context.tokenOffset < context.tokenEndOffset &&
            node.offset < context.tokenEndOffset && node.end > context.tokenOffset;
        if (!GrammarAST.isKeyword(feature) || !FIELD_KEYWORDS.has(feature.value)) {
            return occurrences.some(node => !overlapsReplacement(node));
        }

        // Field labels live outside their assigned value's CST node. Associate
        // the label being edited with the first following assigned value.
        const label = CstUtils.flattenCst(cst).find(node =>
            GrammarAST.isKeyword(node.grammarSource) &&
            node.grammarSource.value === feature.value && overlapsReplacement(node));
        const activeOccurrence = label && occurrences.find(node => node.offset >= label.end);
        return occurrences.some(node => node !== activeOccurrence);
    }

    protected fieldProperty(feature: GrammarAST.AbstractElement,
        rule: GrammarAST.ParserRule | undefined, assignment: GrammarAST.Assignment | undefined): string | undefined {
        if (GrammarAST.isKeyword(feature) && FIELD_KEYWORDS.has(feature.value)) {
            return FIELD_KEYWORDS.get(feature.value);
        }
        if (assignment && (rule?.name === 'Medication' || rule?.name === 'Plan')) {
            return assignment.feature === 'name' ? undefined : assignment.feature;
        }
        return RULE_FIELDS.get(rule?.name ?? '');
    }

}


const FIELD_KEYWORDS = new Map([
    ['dose', 'amount'], ['route', 'route'], ['frequency', 'frequency'],
    ['strength', 'productStrength'], ['doseForm', 'doseForm'], ['rxcui', 'rxcui'], ['rxnormRelease', 'rxnormRelease'],
    ['for', 'patient'], ['prescribe', 'medication']
]);
const RULE_FIELDS = new Map([
    ['DoseAmount', 'amount'], ['Unit', 'unit'], ['Route', 'route'], ['Frequency', 'frequency'],
    ['ProductStrength', 'productStrength'], ['UnquotedStrength', 'productStrength'],
    ['ProductForm', 'doseForm'], ['UnquotedForm', 'doseForm']
]);
