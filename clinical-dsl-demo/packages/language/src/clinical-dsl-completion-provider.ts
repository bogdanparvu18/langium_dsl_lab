import { AstUtils, CstUtils, GrammarAST, GrammarUtils, type AstNode, type CstNode, type LangiumDocument, type MaybePromise } from 'langium';
import {
    DefaultCompletionProvider,
    type CompletionAcceptor,
    type CompletionContext,
    type NextFeature
} from 'langium/lsp';

import { DEMO_AMOUNT_OPTIONS } from './clinical-dsl-presets.js';
import { isMedication, isPlan } from './generated/ast.js';
import { CompletionItemKind, type CancellationToken, type CompletionParams, type CompletionList } from 'vscode-languageserver';

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
    override async getCompletion(document: LangiumDocument, params: CompletionParams, cancelToken?: CancellationToken): Promise<CompletionList | undefined> {
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
    ['strength', 'productStrength'], ['doseForm', 'doseForm'],
    ['for', 'patient'], ['prescribe', 'medication']
]);
const RULE_FIELDS = new Map([
    ['DoseAmount', 'amount'], ['Unit', 'unit'], ['Route', 'route'], ['Frequency', 'frequency'],
    ['ProductStrength', 'productStrength'], ['UnquotedStrength', 'productStrength'],
    ['ProductForm', 'doseForm'], ['UnquotedForm', 'doseForm']
]);
