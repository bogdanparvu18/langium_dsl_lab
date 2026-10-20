import type { RxNormPreviewState } from './rxnorm.js';

/** Present Scala's result. This module never performs terminology matching. */
export function withRxNormPreview(json: string, state: RxNormPreviewState): string {
    const plan = JSON.parse(json) as { name: string; medication: { name: string; [key: string]: unknown } };
    let rxnorm: Record<string, unknown>;
    switch (state.kind) {
        case 'notChecked':
            rxnorm = { status: 'notChecked', message: 'Save this document or run Resolve Medications with RxNorm.' };
            break;
        case 'pending':
            rxnorm = { status: 'checking', message: 'RxNorm verification is in progress. Reopen Preview JSON when it finishes.' };
            break;
        case 'failed':
            rxnorm = { status: 'unavailable', message: 'RxNorm verification could not be completed. See Clinical DSL RxNorm output.' };
            break;
        case 'complete': {
            const { report, resolution } = state;
            if (resolution.mention.orderId !== plan.name || resolution.mention.originalText !== plan.medication.name) {
                throw new Error('The RxNorm result does not belong to the previewed plan and medication.');
            }
            const metadata = {
                status: resolution.status, release: report.terminologyRelease,
                scope: report.terminologyScope, snapshotFingerprint: report.snapshotFingerprint
            };
            if (resolution.status === 'unresolved') {
                rxnorm = { ...metadata, code: 'MEDICATION_UNKNOWN', error: 'medication unknown', concept: null };
            } else if (resolution.status === 'resolved') {
                rxnorm = { ...metadata, concept: resolution.initialConcept,
<<<<<<< HEAD
                    ingredients: resolution.ingredients.map(i => i.concept) };
            } else if (resolution.status === 'needsClarification') {
                rxnorm = { ...metadata, message: 'Medication needs clarification.',
=======
                    ingredients: resolution.ingredients.map(i => i.concept),
                    ...(resolution.selectedProduct ? { selectedProduct: resolution.selectedProduct,
                        productEvidence: resolution.productEvidence } : {}) };
            } else if (resolution.status === 'productNotFound') {
                rxnorm = { ...metadata, code: 'PRODUCT_NOT_FOUND',
                    error: 'No product matches productStrength and doseForm in this local RxNorm release.',
                    concept: resolution.initialConcept, selectedProduct: null, diagnostics: resolution.diagnostics };
            } else if (resolution.status === 'needsClarification') {
                rxnorm = { ...metadata, message: 'Medication needs clarification.',
                    diagnostics: resolution.diagnostics,
>>>>>>> 9fd1951ae61e93fd876f1fad30f65df74378bd13
                    candidates: (resolution.candidates ?? []).map(candidate => candidate.concept) };
            } else {
                rxnorm = { ...metadata, code: 'INVALID_MEDICATION_ROLE', error: 'Medication does not match the required semantic role.' };
            }
            break;
        }
    }
    return JSON.stringify({ ...plan, medication: { ...plan.medication, rxnorm } }, null, 2);
}

export function rxnormPreviewTitle(state: RxNormPreviewState): string {
    if (state.kind === 'pending') return 'Preview JSON — checking RxNorm';
    if (state.kind === 'failed') return 'Preview JSON — RxNorm unavailable';
    if (state.kind === 'complete' && state.resolution.status === 'unresolved') {
        return 'Preview JSON — medication unknown';
    }
<<<<<<< HEAD
=======
    if (state.kind === 'complete' && state.resolution.status === 'productNotFound') return 'Preview JSON — product not found';
>>>>>>> 9fd1951ae61e93fd876f1fad30f65df74378bd13
    return 'Preview JSON';
}
