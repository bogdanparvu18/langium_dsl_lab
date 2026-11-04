import { GrammarUtils, type ValidationAcceptor, type ValidationChecks } from 'langium';
import type { ClinicalDslAstType, Medication, Patient, Model } from './generated/ast.js';
import type { ClinicalDslServices } from './clinical-dsl-module.js';
import {
    DEMO_AMOUNT_OPTIONS
} from './clinical-dsl-presets.js';

export function registerValidationChecks(services: ClinicalDslServices): void {
    const validator = services.validation.ClinicalDslValidator;
    const checks: ValidationChecks<ClinicalDslAstType> = {
        Model: validator.checkDuplicateNames,
        Patient: validator.checkPatientStartsWithCapital,
        Medication: [validator.checkMedicationFields, validator.checkMedicationAmount, validator.checkProductQualifiers, validator.checkProductBinding]
    };
    services.validation.ValidationRegistry.register(checks, validator);
}

export class ClinicalDslValidator {
    checkMedicationFields(medication: Medication, accept: ValidationAcceptor): void {
        const fields = [
            ['amount', 'dose'], ['route', 'route'], ['frequency', 'frequency'],
            ['productStrength', 'strength'], ['doseForm', 'doseForm'],
            ['rxcui', 'rxcui'], ['rxnormRelease', 'rxnormRelease']
        ] as const;
        for (const [property, label] of fields) {
            const occurrences = GrammarUtils.findNodesForProperty(medication.$cstNode, property);
            if (occurrences.length > 1) {
                accept('error', `Duplicate ${label}: specify this field only once.`, {
                    node: medication, property
                });
            }
        }
        for (const [property, example] of [
            ['amount', 'dose 10 mg'], ['route', 'route PO'], ['frequency', 'frequency BID']
        ] as const) {
            if (medication[property] === undefined) {
                accept('error', `Missing ${property}. Example: ${example}.`, { node: medication, property: 'name' });
            }
        }
    }
    checkDuplicateNames(model: Model, accept: ValidationAcceptor): void {
        // Case-insensitive linking must never choose silently between two declarations.
        for (const [kind, group] of [['patient', model.patient], ['medication', model.medication], ['plan', model.plan]] as const) {
            const seen = new Set<string>();
            for (const item of group) {
                if (!item.name) continue;
                const name = item.name.toLowerCase();
                if (seen.has(name)) {
                    accept('error', `Duplicate ${kind} name "${item.name}" (names are case-insensitive).`, { node: item, property: 'name' });
                } else {
                    seen.add(name);
                }
            }
        }
        const shownPlans = new Set<string>();
        for (const statement of model.display) {
            // Parse recovery can create an unfinished show node without a reference.
            if (!statement.plan?.$refText) continue;
            const name = (statement.plan.ref?.name ?? statement.plan.$refText).toLowerCase();
            if (shownPlans.has(name)) {
                accept('error', `Plan "${statement.plan.$refText}" is shown more than once.`, {
                    node: statement, property: 'plan'
                });
            } else {
                shownPlans.add(name);
            }
        }
    }
    checkProductQualifiers(medication: Medication, accept: ValidationAcceptor): void {
        const strength = medication.productStrength;
        const form = medication.doseForm;
        if (strength !== undefined && !/^\s*[0-9]+(?:\.[0-9]+)?\s*(?:mcg|mg|g)(?:\s*\/\s*(?:[0-9]+(?:\.[0-9]+)?\s*)?ml)?\s*$/i.test(strength)) {
            accept('error', 'Use a product strength such as "325 mg" or "160 mg/5 ml".', { node: medication, property: 'productStrength' });
        } else if (strength !== undefined) {
            const numbers = strength.match(/[0-9]+(?:\.[0-9]+)?/g) ?? [];
            if (numbers.some(value => !Number.isFinite(Number(value)) || Number(value) <= 0)) {
                accept('error', 'Product strength values must be positive and finite.', { node: medication, property: 'productStrength' });
            }
        }
        if (form !== undefined && !form.trim()) {
            accept('error', 'Dose form cannot be empty.', { node: medication, property: 'doseForm' });
        }
        if ((strength !== undefined) !== (form !== undefined)) {
            accept('error', 'Specify strength and doseForm together to identify a product.', {
                node: medication, property: strength !== undefined ? 'productStrength' : 'doseForm'
            });
        }
    }

    checkProductBinding(medication: Medication, accept: ValidationAcceptor): void {
        const { rxcui, rxnormRelease } = medication;
        if ((rxcui !== undefined) !== (rxnormRelease !== undefined)) {
            accept('error', rxcui !== undefined
                ? 'An explicit RxCUI requires rxnormRelease, for example rxnormRelease "2026-10-05".'
                : 'An RxNorm release requires a selected product RxCUI, for example rxcui "900001" (syntax example only).', {
                node: medication, property: rxcui !== undefined ? 'rxcui' : 'rxnormRelease'
            });
        }
        if (rxcui !== undefined && !/^[1-9][0-9]{0,19}$/.test(rxcui)) {
            accept('error', 'RxCUI must be a quoted positive digit string of at most 20 digits, for example rxcui "900001" (syntax example only).', {
                node: medication, property: 'rxcui'
            });
        }
        if (rxnormRelease !== undefined) {
            const date = /^\d{4}-\d{2}-\d{2}$/.test(rxnormRelease) && !rxnormRelease.startsWith('0000-')
                ? new Date(`${rxnormRelease}T00:00:00.000Z`) : undefined;
            if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== rxnormRelease) {
                accept('error', 'RxNorm release must be a valid YYYY-MM-DD date, for example rxnormRelease "2026-10-05".', {
                    node: medication, property: 'rxnormRelease'
                });
            }
        }
    }

    checkPatientStartsWithCapital(
        patient: Patient,
        accept: ValidationAcceptor
    ): void {
        if (patient.name &&
            patient.name[0] !== patient.name[0].toUpperCase()) {
            accept('warning', 'Patient name should start with a capital letter.', {
                node: patient,
                property: 'name'
            });
        }
    }

    checkMedicationAmountFromList(
    medication: Medication,
    accept: ValidationAcceptor
): void {
    if (medication.amount === undefined || !Number.isFinite(medication.amount)) {
        accept(
            'error',
            'The amount must be a finite number.',
            { node: medication, property: 'amount' }
        );
        return;
    }

    if (!DEMO_AMOUNT_OPTIONS.includes(medication.amount)) {
        accept(
            'error',
            `Amount not in the prototype list. Allowed values: ${
                DEMO_AMOUNT_OPTIONS.join(', ')
            }. This is not a clinical safety check.`,
            { node: medication, property: 'amount' }
        );
    }
}

    checkMedicationAmount(
        medication: Medication,
        accept: ValidationAcceptor
    ): void {
        // A prototype data rule, not a drug-specific dose-safety assessment.
        if (medication.amount !== undefined && (!Number.isFinite(medication.amount) || medication.amount <= 0)) {
            accept('error', 'The amount must be a finite number greater than zero.', {
                node: medication,
                property: 'amount'
            });
        }
    }
}
