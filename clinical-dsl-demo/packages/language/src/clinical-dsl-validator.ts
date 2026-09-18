import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { ClinicalDslAstType, Person } from './generated/ast.js';
import type { ClinicalDslServices } from './clinical-dsl-module.js';

/**
 * Register custom validation checks.
 */
export function registerValidationChecks(services: ClinicalDslServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ClinicalDslValidator;
    const checks: ValidationChecks<ClinicalDslAstType> = {
        Person: validator.checkPersonStartsWithCapital
    };
    registry.register(checks, validator);
}

/**
 * Implementation of custom validations.
 */
export class ClinicalDslValidator {

    checkPersonStartsWithCapital(person: Person, accept: ValidationAcceptor): void {
        if (person.name) {
            const firstChar = person.name.substring(0, 1);
            if (firstChar.toUpperCase() !== firstChar) {
                accept('warning', 'Person name should start with a capital.', { node: person, property: 'name' });
            }
        }
    }

}
