import { AstUtils, CstUtils, GrammarAST, GrammarUtils, type CstNode, type LangiumDocument } from 'langium';
import { CompletionItemKind, type CompletionItem, type TextEdit } from 'vscode-languageserver';
import { isMedication, type Medication } from './generated/ast.js';
import type { RxNormProduct } from './rxnorm-product-search.js';

export type ProductCompletionTarget =
    | { kind: 'standalone'; start: number; end: number }
    | { kind: 'name' | 'bare' | 'rxcui' | 'product'; start: number; end: number; medication: Medication };

function newAlias(document: LangiumDocument, product: RxNormProduct, medication?: Medication): string {
    const candidate = product.display.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[A-Za-z][A-Za-z0-9_]*/)?.[0].slice(0, 60) ?? 'Medication';
    const names = new Set(AstUtils.streamContents(document.parseResult.value).filter(isMedication)
        .filter(node => node !== medication && typeof node.name === 'string').map(node => node.name.toLowerCase()));
    if (!names.has(candidate.toLowerCase())) return candidate;
    const stem = `${candidate}_${product.rxcui}`;
    let alias = stem;
    let suffix = 2;
    while (names.has(alias.toLowerCase())) alias = `${stem}_${suffix++}`;
    return alias;
}

/** Apply the exact label and identifier together in one native completion. */
export function productCompletion(document: LangiumDocument, target: ProductCompletionTarget,
    product: RxNormProduct, prefix: string, index: number): CompletionItem | undefined {
    const text = document.textDocument;
    const source = text.getText();
    const range = (start: number, end: number) => ({ start: text.positionAt(start), end: text.positionAt(end) });
    // Escape the DSL delimiter, backslash and line breaks. Langium strings contain literal Unicode.
    const escapeDisplay = (delimiter: string) => product.display.replace(/\\/g, '\\\\')
        .split(delimiter).join('\\' + delimiter).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    const display = '"' + escapeDisplay('"') + '"';
    const id = `"${product.rxcui}"`;
    const pair = `product ${display} rxcui ${id}`;
    const edits: TextEdit[] = [];
    const edit = (start: number, end: number, newText: string) => edits.push({ range: range(start, end), newText });
    const medication = target.kind === 'standalone' ? undefined : target.medication;
    const cst = medication?.$cstNode;
    const leaves = cst ? CstUtils.flattenCst(cst).filter(node => !node.hidden).toArray() : [];
    const colon = leaves.find(node => node.text === ':');
    if (leaves.some(node => node.text === '{')) return undefined;

    let { start, end } = target;
    let alias: string;
    let replacement: string;
    if (target.kind === 'standalone' || (target.kind === 'name' && !colon)) {
        alias = newAlias(document, product, medication);
        replacement = `${target.kind === 'standalone' ? 'Medication ' : ''}${alias}: ${pair}`;
    } else {
        if (!cst || !colon) return undefined;
        alias = target.medication.name;
        function field(keyword: string, property = keyword) {
            const labels = leaves.filter(node => GrammarAST.isKeyword(node.grammarSource) &&
                node.grammarSource.value === keyword &&
                AstUtils.getContainerOfType(node.grammarSource, GrammarAST.isParserRule)?.name === 'Medication');
            const values = GrammarUtils.findNodesForProperty(cst!, property).filter(node => node.length > 0);
            return { label: labels[0], value: values[0], repeated: labels.length > 1 || values.length > 1 };
        }
        const label = field('product', 'productName');
        const cui = field('rxcui');
        const legacy = field('rxnormRelease');
        if (label.repeated || cui.repeated || legacy.repeated) return undefined;

        function setValue(targetField: ReturnType<typeof field>, value: string) {
            if (targetField.value) edit(targetField.value.offset, targetField.value.end, value);
            else edit(targetField.label.end, targetField.label.end, ` ${value}`);
        }
        function removeFields(fields: ReturnType<typeof field>[]) {
            // Remove obsolete keywords/values and their optional trailing comma, keeping comment text.
            const obsolete: CstNode[] = [];
            for (const field of fields) {
                if (!field.label) continue;
                obsolete.push(field.label);
                if (field.value) obsolete.push(field.value);
                const last = field.value ?? field.label;
                const next = leaves.find(node => node.offset >= last.end);
                if (next?.text === ',' && !(target.kind === 'bare' && last.end <= start && end <= next.offset)) {
                    obsolete.push(next);
                }
            }
            const spans: { start: number; end: number }[] = [];
            for (const node of obsolete.sort((a, b) => a.offset - b.offset)) {
                const previous = spans.at(-1);
                if (previous && /^[ \t]*$/.test(source.slice(previous.end, node.offset))) previous.end = node.end;
                else spans.push({ start: node.offset, end: node.end });
            }
            for (const span of spans) {
                while (source[span.end] === ' ' || source[span.end] === '\t') span.end++;
                if (span.end === source.length || /[\r\n]/.test(source[span.end])) {
                    while (source[span.start - 1] === ' ' || source[span.start - 1] === '\t') span.start--;
                }
                edit(span.start, span.end, '');
            }
        }
        if (target.kind === 'bare') {
            // The search word is an editing shortcut. Insert a complete, parseable pair at its location.
            replacement = pair;
            if (source[start - 1] === ':') replacement = ' ' + replacement;
            removeFields([label, cui, legacy]);
        } else {
            if (target.kind === 'rxcui' || target.kind === 'product') {
                // Keep the user's delimiters outside the editor's completion/filter range.
                replacement = target.kind === 'rxcui' ? product.rxcui : escapeDisplay(source[start]);
                start++;
                end--;
            } else {
                replacement = alias;
            }
            if (cui.label && target.kind !== 'rxcui') setValue(cui, id);
            if (label.label && target.kind !== 'product') setValue(label, display);
            if (legacy.label && !label.label) {
                // Reuse the old slot so embedded comments and field order survive.
                edit(legacy.label.offset, legacy.label.end, cui.label ? 'product' : `rxcui ${id} product`);
                setValue(legacy, display);
            } else if (legacy.label && !cui.label) {
                edit(legacy.label.offset, legacy.label.end, 'rxcui');
                setValue(legacy, id);
            } else {
                if (cui.label && !label.label) edit(cui.label.offset, cui.label.offset, `product ${display} `);
                if (label.label && !cui.label) {
                    if (target.kind === 'product') edit(target.end, target.end, ` rxcui ${id}`);
                    else edit(label.label.offset, label.label.offset, `rxcui ${id} `);
                }
                if (!cui.label && !label.label) {
                    const next = source[colon.end];
                    edit(colon.end, colon.end, ` ${pair}${next && !/\s/.test(next) ? ' ' : ''}`);
                }
                if (legacy.label) removeFields([legacy]);
            }
        }
    }
    return {
        label: product.display,
        kind: CompletionItemKind.Value,
        detail: `${product.tty} · RxCUI ${product.rxcui} · RxNorm ${product.release}`,
        documentation: { kind: 'plaintext', value: `Select this exact RxNorm product. Local identifier: ${alias}. ` +
            'Administered dose, route and frequency remain yours to enter. Existing strength and doseForm are retained and checked during resolution.' },
        filterText: `${prefix} ${product.display}`,
        sortText: `0_${String(index).padStart(3, '0')}_${product.rxcui}`,
        preselect: false,
        commitCharacters: [],
        command: {
            title: 'Find Canadian product monograph',
            command: 'clinical-dsl.monograph.afterAcceptance',
            arguments: [{ uri: text.uri, alias, rxcui: product.rxcui, display: product.display, release: product.release }]
        },
        textEdit: { range: range(start, end), newText: replacement },
        ...(edits.length ? { additionalTextEdits: edits } : {})
    };
}
