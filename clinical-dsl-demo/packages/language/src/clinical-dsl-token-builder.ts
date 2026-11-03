import { DefaultTokenBuilder, type GrammarAST } from 'langium';
import type { TokenType } from 'chevrotain';

/** Patient's syntax remains unchanged; only medication/plan keywords are case-insensitive. */
export class ClinicalDslTokenBuilder extends DefaultTokenBuilder {
    protected override buildKeywordToken(keyword: GrammarAST.Keyword, terminals: TokenType[], _caseInsensitive: boolean): TokenType {
        const patientKeywords = new Set(['patient', 'Patient', 'age', 'condition']);
        return super.buildKeywordToken(keyword, terminals, !patientKeywords.has(keyword.value));
    }
}
