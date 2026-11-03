import { DefaultLinker, type AstNodeDescription, type LinkingError, type ReferenceInfo } from 'langium';

/** Explain ambiguities rather than silently selecting the first indexed node. */
export class ClinicalDslLinker extends DefaultLinker {
    override getCandidate(info: ReferenceInfo): AstNodeDescription | LinkingError {
        const candidates = this.scopeProvider.getScope(info).getElements(info.reference.$refText).toArray();
        if (candidates.length > 1) {
            const kind = this.reflection.getReferenceType(info).toLowerCase();
            return {
                info,
                message: `Ambiguous ${kind} reference "${info.reference.$refText}": ${candidates.length} visible declarations match ignoring case. Rename the conflicting declarations or use a unique local declaration.`
            };
        }
        return candidates[0] ?? this.createLinkingError(info);
    }
}
