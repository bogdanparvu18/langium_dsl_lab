import { CstUtils, type CstNode } from 'langium';
import type { Medication } from './generated/ast.js';

export interface MonographSource {
    rxcui: string;
    release: string;
    din: string;
    sha256: string;
}

type SourceSelection =
    | { status: 'missing' }
    | { status: 'invalid'; message: string }
    | { status: 'selected'; source: MonographSource };

const marker = /^\/\/\s*@monograph\b/i;
const reference = /^\/\/\s*@monograph[ \t]+([a-z_][a-z_0-9]*)[ \t]+([1-9][0-9]{0,19})[ \t]+(\d{4}-\d{2}-\d{2})[ \t]+(\d{8})[ \t]+([a-f0-9]{64})\s*$/i;

/** Only stand-alone single-line comment tokens leading into this declaration
 * can identify its source. A string literal or comment on the previous order cannot. */
export function monographSourceComments(medication: Medication): CstNode[] {
    const cst = medication.$cstNode;
    if (!cst) return [];
    const matches: CstNode[] = [];
    const text = cst.root.fullText;
    let prev = CstUtils.getPreviousNode(cst);
    while (prev?.hidden) {
        if (CstUtils.isCommentNode(prev, ['SL_COMMENT']) && marker.test(prev.text)) {
            const line = text.lastIndexOf('\n', prev.offset - 1) + 1;
            if (/^[\t ]*$/.test(text.slice(line, prev.offset))) matches.push(prev);
        }
        prev = CstUtils.getPreviousNode(prev);
    }
    return matches.reverse();
}

export function readMonographSource(medication: Medication): SourceSelection {
    const markers = monographSourceComments(medication);
    if (!markers.length) return { status: 'missing' };
    const match = markers.length === 1 && reference.exec(markers[0].text);
    if (!match) return { status: 'invalid', message: 'The monograph source reference is malformed or duplicated. Select the Canadian presentation again.' };
    const [, alias, rxcui, release, din, sha256] = match;
    if (alias !== medication.name || rxcui !== medication.rxcui ||
        (medication.rxnormRelease !== undefined && release !== medication.rxnormRelease)) {
        return { status: 'invalid', message: 'The monograph source belongs to a different Medication, RxCUI or release. Select the Canadian presentation again.' };
    }
    return { status: 'selected', source: { rxcui, release, din, sha256: sha256.toLowerCase() } };
}

/** Refresh only this declaration's reserved metadata, retaining ordinary comments and layout. */
export function monographSourceEdits(medication: Medication, source: MonographSource) {
    const cst = medication.$cstNode;
    if (!cst || medication.rxcui !== source.rxcui) return [];
    const line = `// @monograph ${medication.name} ${source.rxcui} ${source.release} ${source.din} ${source.sha256}`;
    if (!reference.test(line)) return [];
    const comments = monographSourceComments(medication);
    if (comments.length) {
        const [first, ...duplicates] = comments;
        const edits = first.text === line ? [] : [{ start: first.offset, end: first.end, text: line }];
        return edits.concat(duplicates.map(c => ({ start: c.offset, end: c.end, text: '' })));
    }
    const text = cst.root.fullText;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const before = text.slice(text.lastIndexOf('\n', cst.offset - 1) + 1, cst.offset);
    const indent = /^\s*$/.test(before) ? before : '';
    const prefix = before === indent ? '' : eol;
    return [{ start: cst.offset, end: cst.offset, text: prefix + line + eol + indent }];
}
