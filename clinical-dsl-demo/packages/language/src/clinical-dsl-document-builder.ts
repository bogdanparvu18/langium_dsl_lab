import { DefaultDocumentBuilder, type LangiumDocument } from 'langium';

/**
 * Adding or renaming a declaration can make a previously resolved reference
 * ambiguous even when its old target file did not change. Recheck reference
 * documents on workspace updates instead of depending only on old target edges.
 * Use the language id, not the filename: unsaved clinical editors have untitled URIs.
 */
export class ClinicalDslDocumentBuilder extends DefaultDocumentBuilder {
    protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
        if (document.textDocument.languageId === 'clinical-dsl' &&
            document.references.length > 0 && changedUris.size > 0) {
            return true;
        }
        return super.shouldRelink(document, changedUris);
    }
}
