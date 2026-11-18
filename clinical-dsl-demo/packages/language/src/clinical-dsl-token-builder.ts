import { DefaultLexer, DefaultTokenBuilder, type GrammarAST, type TokenizeOptions } from 'langium';
import type { TokenType } from 'chevrotain';

/** Keep Patient declaration keywords case-sensitive. Identifier rules make
 * keyword-looking names contextual rather than reserving their spelling globally. */
export class ClinicalDslTokenBuilder extends DefaultTokenBuilder {
    protected override buildKeywordToken(keyword: GrammarAST.Keyword, terminals: TokenType[], _caseInsensitive: boolean): TokenType {
        const patientKeywords = new Set(['patient', 'Patient', 'age', 'condition']);
        return super.buildKeywordToken(keyword, terminals, !patientKeywords.has(keyword.value));
    }
}

/** Within unquoted dose forms "product" is a word unless a quoted field value follows. */
export class ClinicalDslLexer extends DefaultLexer {
    override tokenize(text: string, options?: TokenizeOptions) {
        const result = super.tokenize(text, options);
        const { tokens } = result;
        const id = this.definition.ID;
        let inDoseForm = false;
        for (let i = 0; i < tokens.length; ++i) {
            const token = tokens[i];
            if (inDoseForm && token.tokenType.name === 'product' && tokens[i + 1]?.tokenType.name !== 'STRING') {
                token.tokenType = id;
                token.tokenTypeIdx = id.tokenTypeIdx!;
            }
            const kind = token.tokenType.name;
            inDoseForm = kind === 'doseForm' || (inDoseForm && (kind === 'ID' || kind === 'dose'));
        }
        return result;
    }
}
