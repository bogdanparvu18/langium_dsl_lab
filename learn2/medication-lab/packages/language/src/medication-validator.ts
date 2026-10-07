import type { ValidationChecks } from 'langium';
import type { MedicationAstType } from './generated/ast.js';
import type { MedicationServices } from './medication-module.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: MedicationServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.MedicationValidator;
    const checks: ValidationChecks<MedicationAstType> = {
        // TODO: Declare validators for your properties
        // See doc : https://langium.org/docs/learn/workflow/create_validations/
        /*
        Element: validator.checkElement
        */
    };
    registry.register(checks, validator);
}

/**
 * Implementation of custom validations.
 */
export class MedicationValidator {

    // TODO: Add logic here for validation checks of properties
    // See doc : https://langium.org/docs/learn/workflow/create_validations/
    /*
    checkElement(element: Element, accept: ValidationAcceptor): void {
        // Always accepts
    }
    */
}
