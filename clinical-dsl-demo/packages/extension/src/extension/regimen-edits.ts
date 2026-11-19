import { AstUtils, CstUtils, GrammarUtils } from 'langium';
import { formatFrequency, normalizeFrequency, type Model, type Route } from 'clinical-dsl-language';
import { parseClinicalDocumentResult } from './context-help.js';

interface Binding {
    alias: string;
    rxcui: string;
    display?: string;
    release: string;
}

function medicationAt(model: Model, positionOrAlias: number | string, release: string) {
    const medication = model.medication.find(med => typeof positionOrAlias === 'string'
        ? med.name === positionOrAlias
        : med.$cstNode && med.$cstNode.offset <= positionOrAlias && positionOrAlias <= med.$cstNode.end);
    if (!medication?.$cstNode || !medication.name || !/^[1-9]\d{0,19}$/.test(medication.rxcui ?? '')) return;
    if (model.medication.some(other => other !== medication && other.name?.toLowerCase() === medication.name.toLowerCase())) return;
    if (['rxcui', 'productName', 'rxnormRelease'].some(field =>
        GrammarUtils.findNodesForProperty(medication.$cstNode, field).length > 1)) return;
    // A legacy binding can identify the product by its release and ID.
    if ((medication.productName === undefined ? medication.rxnormRelease !== release : !medication.productName.trim()) ||
        (medication.rxnormRelease !== undefined && medication.rxnormRelease !== release)) return;
    return medication;
}

export function bindingAt(text: string, positionOrAlias: number | string, release: string) {
    const medication = medicationAt(parseClinicalDocumentResult(text).value, positionOrAlias, release);
    if (medication?.rxcui) return { alias: medication.name, rxcui: medication.rxcui, display: medication.productName };
    return undefined;
}

function parseDose(value: string) {
    const match = /^(\d+(?:\.\d+)?)\s*(mcg|mg|g|ml|puff|unit)$/i.exec(value.trim());
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    return { amount, text: match[1], unit: match[2].toLowerCase() };
}

export function validDraftDose(value: string): boolean {
    return parseDose(value) !== undefined;
}

export function validDraftFrequency(value: string): boolean {
    return normalizeFrequency(value) !== undefined;
}

const canadianRoute: Record<Route, string> = {
    PO: 'ORAL', IV: 'INTRAVENOUS', IM: 'INTRAMUSCULAR', SC: 'SUBCUTANEOUS',
    PR: 'RECTAL', SL: 'SUBLINGUAL', BUCC: 'BUCCAL'
};

/** Add missing values from a single source instruction; keep all existing tokens intact. */
export function regimenEdits(source: string, binding: Binding, dose: string, frequency: string, supportedRoutes?: readonly string[]) {
    const parsedDose = parseDose(dose);
    const canonicalFrequency = normalizeFrequency(frequency);
    const frequencyText = formatFrequency(frequency);
    if (!parsedDose || !canonicalFrequency || !frequencyText) return undefined;
    const parsed = parseClinicalDocumentResult(source);
    const medication = medicationAt(parsed.value, binding.alias, binding.release);
    const cst = medication?.$cstNode;
    if (!medication || !cst || medication.rxcui !== binding.rxcui || medication.productName !== binding.display) return undefined;
    if (parsed.parserErrors.length || parsed.lexerErrors.length) {
        // Parse recovery can omit incomplete or unrecognized fields from the CST.
        // Isolate this declaration so unrelated unfinished orders can still be edited.
        const next = AstUtils.streamContents(parsed.value).map(node => node.$cstNode?.offset)
            .filter((offset): offset is number => offset !== undefined && offset > cst.offset).reduce(
                (end, offset) => Math.min(end, offset), source.length);
        const isolated = parseClinicalDocumentResult(source.slice(cst.offset, next));
        if (isolated.parserErrors.length || isolated.lexerErrors.length || isolated.value.medication.length !== 1) return undefined;
    }
    for (const field of ['amount', 'unit', 'frequency', 'route']) {
        if (GrammarUtils.findNodesForProperty(cst, field).length > 1) return undefined;
    }
    const hasDose = medication.amount !== undefined;
    const hasFrequency = medication.frequency !== undefined;
    if (hasDose && hasFrequency) return [];
    const route = medication.route;
    if (route && supportedRoutes?.length && !supportedRoutes.some(value => value.trim().toUpperCase() === canadianRoute[route])) return undefined;
    if (hasDose && (medication.amount !== parsedDose.amount || medication.unit !== parsedDose.unit)) return undefined;
    if (hasFrequency && normalizeFrequency(medication.frequency!) !== canonicalFrequency) return undefined;

    const fields: string[] = [];
    if (!hasDose) fields.push(`dose ${parsedDose.text} ${parsedDose.unit}`);
    if (!hasFrequency) fields.push(`frequency ${frequencyText}`);
    const last = CstUtils.flattenCst(cst).filter(node => !node.hidden).toArray().at(-1);
    if (!last) return undefined;
    const suffix = source[last.end] && !/\s/.test(source[last.end]) ? ' ' : '';
    return [{ start: last.end, end: last.end, text: ' ' + fields.join(' ') + suffix }];
}
