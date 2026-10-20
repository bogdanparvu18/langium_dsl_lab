import { DefaultValueConverter, type CstNode, type GrammarAST, type ValueType } from 'langium';

/** Preserve word boundaries: Langium concatenates data-rule tokens by default. */
export class ClinicalDslValueConverter extends DefaultValueConverter {
    protected override runConverter(rule: GrammarAST.AbstractRule, input: string, node: CstNode): ValueType {
        if (rule.name === 'UnquotedStrength' || rule.name === 'UnquotedForm') {
            return node.text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ').replace(/\s+/g, ' ').trim();
        }
        return super.runConverter(rule, input, node);
    }
}
