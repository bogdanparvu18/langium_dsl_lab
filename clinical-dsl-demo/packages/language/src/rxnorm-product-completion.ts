import { AstUtils, CstUtils, GrammarAST, GrammarUtils, type CstNode, type LangiumDocument } from 'langium';
import { CompletionItemKind, type CompletionItem, type TextEdit } from 'vscode-languageserver';
import { isMedication, type Medication } from './generated/ast.js';
import type { RxNormProduct } from './rxnorm-product-search.js';

/** Apply the exact label and identifier together in one native completion. */
export function productCompletion(document: LangiumDocument, medication: Medication, name: CstNode,
    product: RxNormProduct, prefix: string, index: number, bindingValue?: CstNode): CompletionItem | undefined {
    const cst = medication.$cstNode!;
    const leaves = CstUtils.flattenCst(cst).filter(node => !node.hidden).toArray();
    const colon = leaves.find(node => node.text === ':');
    // Product bindings are supported by the colon syntax only.
    if (leaves.some(node => node.text === '{')) return undefined;
    const range = (start: number, end: number) => ({ start: document.textDocument.positionAt(start), end: document.textDocument.positionAt(end) });
    // Escape the DSL delimiter, backslash and line breaks. Other Unicode characters
    // are literal in Langium strings (the converter does not decode JSON \u escapes).
    const display = '"' + product.display.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
    const id = `"${product.rxcui}"`;
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
        replacement = `${alias}: product ${display} rxcui ${id}`;
    } else {
        function field(keyword: string, property = keyword) {
            const labels = leaves.filter(node => GrammarAST.isKeyword(node.grammarSource) &&
                node.grammarSource.value === keyword &&
                AstUtils.getContainerOfType(node.grammarSource, GrammarAST.isParserRule)?.name === 'Medication');
            const values = GrammarUtils.findNodesForProperty(cst, property).filter(node => node.length > 0);
            return { label: labels[0], value: values[0], repeated: labels.length > 1 || values.length > 1 };
        }
        const label = field('product', 'productName');
        const cui = field('rxcui');
        const legacy = field('rxnormRelease');
        if (label.repeated || cui.repeated || legacy.repeated) return undefined;

        const edit = (start: number, end: number, newText: string) => edits.push({ range: range(start, end), newText });
        function setValue(target: ReturnType<typeof field>, value: string) {
            if (target.value) edit(target.value.offset, target.value.end, value);
            else edit(target.label.end, target.label.end, ` ${value}`);
        }
        if (cui.label && !bindingValue) setValue(cui, id);
        if (label.label) setValue(label, display);
        if (legacy.label && !label.label) {
            // Reuse the old slot so embedded comments, commas and field order survive.
            edit(legacy.label.offset, legacy.label.end, cui.label ? 'product' : `rxcui ${id} product`);
            setValue(legacy, display);
        } else {
            if (cui.label && !label.label) edit(cui.label.offset, cui.label.offset, `product ${display} `);
            if (label.label && !cui.label) edit(label.label.offset, label.label.offset, `rxcui ${id} `);
            if (!cui.label && !label.label) {
                const next = document.textDocument.getText()[colon.end];
                edit(colon.end, colon.end, ` product ${display} rxcui ${id}${next && !/\s/.test(next) ? ' ' : ''}`);
            }
            if (legacy.label) {
                // Delete just the obsolete tokens. Comments between them belong to the author.
                const lastToken = legacy.value ?? legacy.label;
                const following = leaves.find(node => node.offset >= lastToken.end);
                const tokens = [legacy.label, ...(legacy.value ? [legacy.value] : []), ...(following?.text === ',' ? [following] : [])];
                const source = document.textDocument.getText();
                let start = tokens[0].offset;
                let end = tokens[0].end;
                for (const token of tokens.slice(1)) {
                    if (source.slice(end, token.offset).trim()) {
                        edit(start, end, '');
                        start = token.offset;
                    }
                    end = token.end;
                }
                edit(start, end, '');
            }
        }
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
