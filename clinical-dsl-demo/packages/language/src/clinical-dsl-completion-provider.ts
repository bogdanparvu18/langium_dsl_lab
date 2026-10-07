import { AstUtils, GrammarAST, type MaybePromise } from 'langium';
import {
    DefaultCompletionProvider,
    type CompletionAcceptor,
    type CompletionContext,
    type NextFeature
} from 'langium/lsp';

import { DEMO_AMOUNT_OPTIONS } from './clinical-dsl-presets.js';

/** Fictional items for testing the editor, NOT a clinical formulary. */
const MEDICATION_CATALOG: ReadonlyArray<{
    name: string;
    description: string;
}> = [
    { name: 'DemoMedA', description: 'Fictional medication A for syntax testing.' },
    { name: 'DemoMedB', description: 'Fictional medication B for syntax testing.' },
    { name: 'DemoMedC', description: 'Fictional medication C for syntax testing.' }
];

/** Adds name suggestions, preserving Langium keyword/reference completion. */
export class ClinicalDslCompletionProvider extends DefaultCompletionProvider {
    protected override completionFor(
        context: CompletionContext,
        next: NextFeature,
        acceptor: CompletionAcceptor
    ): MaybePromise<void> {
        const assignment = AstUtils.getContainerOfType(
            next.feature, GrammarAST.isAssignment
        );
        const rule = AstUtils.getContainerOfType(
            next.feature, GrammarAST.isParserRule
        );


        if (
    GrammarAST.isRuleCall(next.feature) &&
    rule?.name === 'DoseAmount'
) {
    DEMO_AMOUNT_OPTIONS.forEach((amount, index) => {
        const text = String(amount);

        acceptor(context, {
            label: text,
            insertText: text,
            detail: 'Prototype amount — select a unit next',
            documentation:
                'Fictional test value. Not a patient-specific dose recommendation.',
            sortText: String(index).padStart(3, '0'),
            preselect: false
        });
    });

    return;
}

        // Restrict the catalog to the declaration's `Medication.name=ID`.
        // Other name declarations and cross-references keep their normal behavior.
        if (
            GrammarAST.isRuleCall(next.feature) &&
            next.feature.rule.ref?.name === 'ID' &&
            assignment?.feature === 'name' &&
            rule?.name === 'Medication'
        ) {
            for (const item of MEDICATION_CATALOG) {
                acceptor(context, {
                    label: item.name,
                    insertText: item.name,
                    detail: 'Demo catalog — not prescribing advice',
                    documentation: item.description +
                        '\nEnter the quantity, unit, route, and frequency explicitly.',
                    sortText: item.name
                });
            }
            return;
        }

        return super.completionFor(context, next, acceptor);
    }
}
