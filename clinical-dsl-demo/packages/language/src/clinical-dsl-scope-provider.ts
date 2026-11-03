import {
    AstUtils, DefaultScopeProvider, stream,
    type AstNodeDescription, type ReferenceInfo, type Scope, type Stream
} from 'langium';

/** Case-insensitive scope with explicit local-first precedence and ambiguity rejection. */
class UnambiguousScope implements Scope {
    private readonly names = new Map<string, AstNodeDescription[]>();

    constructor(elements: Stream<AstNodeDescription>, localUri: string) {
        const localNames = new Set<string>();
        for (const description of elements) {
            const name = description.name.toLowerCase();
            const local = description.documentUri.toString() === localUri;
            if (local) {
                if (!localNames.has(name)) {
                    // Replace global candidates, never another local declaration.
                    this.names.set(name, []);
                    localNames.add(name);
                }
            } else if (localNames.has(name)) {
                continue;
            }
            const candidates = this.names.get(name) ?? [];
            candidates.push(description);
            this.names.set(name, candidates);
        }
    }

    getElement(name: string): AstNodeDescription | undefined {
        const candidates = this.names.get(name.toLowerCase());
        return candidates?.length === 1 ? candidates[0] : undefined;
    }

    getElements(name: string): Stream<AstNodeDescription> {
        return stream(this.names.get(name.toLowerCase()) ?? []);
    }

    getAllElements(): Stream<AstNodeDescription> {
        // Do not suggest a name that the linker would have to reject.
        return stream(this.names.values()).filter(candidates => candidates.length === 1)
            .map(candidates => candidates[0]);
    }
}

/**
 * A local declaration shadows globals of the same folded name. If there is no
 * local declaration, exactly one global candidate is required. Repeated exports
 * of the same AST node in local/global scope are counted only once.
 */
export class ClinicalDslScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        const candidates = super.getScope(context).getAllElements()
            .distinct(description => `${description.documentUri.toString()}#${description.path}`);
        return new UnambiguousScope(candidates, AstUtils.getDocument(context.container).uri.toString());
    }
}
