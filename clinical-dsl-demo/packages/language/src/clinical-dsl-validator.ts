import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { ClinicalDslAstType, Patient } from './generated/ast.js';
import type { ClinicalDslServices } from './clinical-dsl-module.js';

export function registerValidationChecks(services: ClinicalDslServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ClinicalDslValidator;

    const checks: ValidationChecks<ClinicalDslAstType> = {
        Patient: validator.checkPatientStartsWithCapital
    };

    registry.register(checks, validator);
}

export class ClinicalDslValidator {

    checkPatientStartsWithCapital(
        patient: Patient,
        accept: ValidationAcceptor
    ): void {

        if (patient.name.length > 0 &&
            patient.name[0] !== patient.name[0].toUpperCase()) {

            accept(
                'warning',
                'Patient name should start with a capital letter.',
                {
                    node: patient,
                    property: 'name'
                }
            );
        }
    }
}