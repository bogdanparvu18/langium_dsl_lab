import { DefaultScopeProvider, StreamScope, type ReferenceInfo, type Scope } from 'langium';

/** Preserve source spelling, but resolve plan and patient references without case sensitivity. */
export class ClinicalDslScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        const base = super.getScope(context);
        return new StreamScope(base.getAllElements(), undefined, { caseInsensitive: true });
    }
}
