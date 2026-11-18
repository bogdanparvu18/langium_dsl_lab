import { AstUtils, CstUtils, GrammarUtils, type AstNode, type CstNode } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import { isMedication } from './generated/ast.js';
import type { ProductCompletionTarget } from './rxnorm-product-completion.js';

type Parsers = Pick<LangiumServices['parser'], 'LangiumParser' | 'Lexer'>;
const declarations = new Set(['patient', 'Patient', 'medication', 'plan', 'show']);

/** Locate only the word or quoted value that accepting a catalog suggestion may replace. */
export function findProductTarget(text: string, offset: number, model: AstNode, parsers: Parsers): ProductCompletionTarget | undefined {
    const { tokens, errors } = parsers.Lexer.tokenize(text);
    const index = tokens.findIndex(t => t.startOffset < offset && offset <= t.endOffset! + 1);
    if (index < 0) return undefined; // Whitespace and comments are hidden by the lexer.
    const token = tokens[index];
    const start = token.startOffset;
    const end = token.endOffset! + 1;
    // The normal lexer emits an error for an open string or block comment and
    // may lex its contents as identifiers. They are never bare product text.
    if (errors.some(error => error.offset < start &&
        (/['"]/.test(text[error.offset]) || text.slice(error.offset - 1, error.offset + 1) === '/*'))) return undefined;
    const nodes = AstUtils.streamContents(model).toArray();
    const declaration = nodes.filter(node => node.$cstNode && node.$cstNode.offset <= start)
        .sort((a, b) => b.$cstNode!.offset - a.$cstNode!.offset)[0];
    const cst = declaration?.$cstNode;
    const isToken = (node: CstNode) => node.offset === start && node.end === end;

    if (isMedication(declaration) && cst && typeof declaration.name === 'string') {
        for (const [property, kind] of [['name', 'name'], ['rxcui', 'rxcui'], ['productName', 'product']] as const) {
            if (GrammarUtils.findNodesForProperty(cst, property).some(isToken)) {
                if ((kind !== 'name' && offset >= end) ||
                    CstUtils.flattenCst(cst).some(node => !node.hidden && node.text === '{')) return undefined;
                return { kind, start, end, medication: declaration };
            }
        }
    }
    if (token.tokenType.name !== 'ID') return undefined;
    // Already parsed identifiers (Patient/Plan names, references, dose forms,
    // etc.) belong to their grammar assignment.
    if (cst && CstUtils.flattenCst(cst).some(isToken)) return undefined;

    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const followingDeclaration = !next || declarations.has(next.tokenType.name);
    const ownLine = previous?.endLine !== token.startLine && next?.startLine !== token.endLine;
    if (!cst) return !previous && ownLine && followingDeclaration ? { kind: 'standalone', start, end } : undefined;

    // At an unrecognized word Langium can stop the declaration early. Parse
    // its left side independently: a missing field value must keep its ordinary
    // completion, including when that value is being entered on the next line.
    const left = parsers.LangiumParser.parse(text.slice(cst.offset, start));
    if (left.parserErrors.length || left.lexerErrors.length) return undefined;
    if (isMedication(declaration)) {
        const colon = CstUtils.flattenCst(cst).some(node => !node.hidden && node.text === ':');
        const continuesMedication = !ownLine || token.startColumn! > 1 || previous?.image === ':' ||
            previous?.image === ',' || !followingDeclaration;
        if (colon && continuesMedication) {
            if (!next || followingDeclaration) return { kind: 'bare', medication: declaration, start, end };
            // Restore fields beyond the temporary search word for reselection.
            // Keep original offsets and hide its separator, leaving comments intact.
            const tail = next.image === ','
                ? text.slice(end, next.startOffset) + ' ' + text.slice(next.startOffset + 1)
                : text.slice(end);
            const masked = text.slice(0, start) + ' '.repeat(end - start) + tail;
            const restored = AstUtils.streamContents(parsers.LangiumParser.parse(masked).value)
                .filter(isMedication).find(node => node.$cstNode?.offset === cst.offset);
            return restored && { kind: 'bare', medication: restored, start, end };
        }
    }
    return ownLine && followingDeclaration ? { kind: 'standalone', start, end } : undefined;
}
