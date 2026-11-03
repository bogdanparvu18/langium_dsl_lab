import { AstUtils, CstUtils, GrammarAST, GrammarUtils, type CstNode, type LangiumDocument } from 'langium';
import { CompletionItemKind, type CompletionItem, type TextEdit } from 'vscode-languageserver';
import { isMedication, type Medication } from './generated/ast.js';
import type { RxNormProduct } from './rxnorm-product-search.js';

/** One native completion transaction changes the visible alias and explicit binding. */
export function productCompletion(document: LangiumDocument, medication: Medication, name: CstNode,
    product: RxNormProduct, prefix: string, index: number, bindingValue?: CstNode): CompletionItem | undefined {
    const cst = medication.$cstNode!;
    const leaves = CstUtils.flattenCst(cst).filter(node => !node.hidden).toArray();
    const colon = leaves.find(node => node.text === ':');
    // Product bindings are supported by the colon syntax only.
    if (leaves.some(node => node.text === '{')) return undefined;
    const range = (start: number, end: number) => ({ start: document.textDocument.positionAt(start), end: document.textDocument.positionAt(end) });
    const fields = [['rxcui', product.rxcui], ['rxnormRelease', product.release]] as const;
    const edits: TextEdit[] = [];
    let alias = medication.name;
    let replacement = alias;
    if (!colon) {
        const candidate = product.display.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[A-Za-z][A-Za-z0-9_]*/)?.[0].slice(0, 60) ?? 'Medication';
        const names = new Set(AstUtils.streamContents(document.parseResult.value).filter(isMedication)
            .filter(node => node !== medication && typeof node.name === 'string').map(node => node.name.toLowerCase()));
        alias = candidate;
        if (names.has(alias.toLowerCase())) alias = `${candidate}_${product.rxcui}`;
        let suffix = 2;
        const stem = alias;
        while (names.has(alias.toLowerCase())) alias = `${stem}_${suffix++}`;
        replacement = `${alias}: ${fields.map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(' ')}`;
    } else {
        const missing: string[] = [];
        for (const [key, value] of fields) {
            const nodes = GrammarUtils.findNodesForProperty(cst, key).filter(node => node.length > 0);
            const labels = leaves.filter(node => GrammarAST.isKeyword(node.grammarSource) && node.grammarSource.value === key);
            // Do not silently repair ambiguous repeated fields during selection.
            if (nodes.length > 1 || labels.length > 1) return undefined;
            // The main edit replaces the typed product prefix inside this string.
            if (bindingValue && key === 'rxcui') continue;
            if (nodes.length) edits.push({ range: range(nodes[0].offset, nodes[0].end), newText: JSON.stringify(value) });
            else if (labels.length) edits.push({ range: range(labels[0].end, labels[0].end), newText: ` ${JSON.stringify(value)}` });
            else missing.push(`${key} ${JSON.stringify(value)}`);
        }
        if (missing.length) edits.push({ range: range(colon.end, colon.end), newText: ` ${missing.join(' ')} ` });
    }
    return {
        label: product.display,
        kind: CompletionItemKind.Value,
        detail: `${product.tty} · RxCUI ${product.rxcui} · RxNorm ${product.release}`,
        documentation: { kind: 'plaintext', value: `Select this exact RxNorm product. Keeps local identifier ${alias}. ` +
            'Administered dose, route and frequency remain yours to enter. Existing strength and doseForm are retained and checked during resolution.' },
        filterText: `${prefix} ${product.display}`,
        sortText: `0_${String(index).padStart(3, '0')}_${product.rxcui}`,
        preselect: false,
        commitCharacters: [],
        textEdit: bindingValue
            ? { range: range(bindingValue.offset + 1, bindingValue.end - 1), newText: product.rxcui }
            : { range: range(name.offset, name.end), newText: replacement },
        ...(edits.length ? { additionalTextEdits: edits } : {})
    };
}
