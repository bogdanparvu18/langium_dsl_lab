import { DefaultTokenBuilder, type GrammarAST } from 'langium';
import type { TokenType } from 'chevrotain';

/** Keep Patient declaration keywords case-sensitive. Identifier rules make
 * keyword-looking names contextual rather than reserving their spelling globally. */
export class ClinicalDslTokenBuilder extends DefaultTokenBuilder {
    protected override buildKeywordToken(keyword: GrammarAST.Keyword, terminals: TokenType[], _caseInsensitive: boolean): TokenType {
        const patientKeywords = new Set(['patient', 'Patient', 'age', 'condition']);
        return super.buildKeywordToken(keyword, terminals, !patientKeywords.has(keyword.value));
    }
}
