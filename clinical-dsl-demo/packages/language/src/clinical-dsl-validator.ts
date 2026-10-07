import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { ClinicalDslAstType, Medication, Patient } from './generated/ast.js';
import type { ClinicalDslServices } from './clinical-dsl-module.js';
import {
    DEMO_AMOUNT_OPTIONS
} from './clinical-dsl-presets.js';

export function registerValidationChecks(services: ClinicalDslServices): void {
    const validator = services.validation.ClinicalDslValidator;
    const checks: ValidationChecks<ClinicalDslAstType> = {
        Patient: validator.checkPatientStartsWithCapital,
        Medication: validator.checkMedicationAmountFromList
    };
    services.validation.ValidationRegistry.register(checks, validator);
}

export class ClinicalDslValidator {
    checkPatientStartsWithCapital(
        patient: Patient,
        accept: ValidationAcceptor
    ): void {
        if (patient.name.length > 0 &&
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
    if (!Number.isFinite(medication.amount)) {
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
        if (!Number.isFinite(medication.amount) || medication.amount <= 0) {
            accept('error', 'The amount must be a finite number greater than zero.', {
                node: medication,
                property: 'amount'
            });
        }
    }
}
