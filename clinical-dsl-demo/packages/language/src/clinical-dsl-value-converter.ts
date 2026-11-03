import { DefaultValueConverter, type CstNode, type GrammarAST, type ValueType } from 'langium';

/** Preserve word boundaries: Langium concatenates data-rule tokens by default. */
export class ClinicalDslValueConverter extends DefaultValueConverter {
    protected override runConverter(rule: GrammarAST.AbstractRule, input: string, node: CstNode): ValueType {
        if (rule.name === 'Unit') return input.toLowerCase();
        if (rule.name === 'Route' || rule.name === 'Frequency') return input.toUpperCase();
        if (rule.name === 'UnquotedStrength') {
            const text = node.text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ')
                .replace(/\s+/g, ' ').trim();
            const match = /^(\d+(?:\.\d+)?)\s*(mcg|mg|g)(?:\s*\/\s*(\d+(?:\.\d+)?)?\s*(ml))?$/i.exec(text);
            if (!match) return text;
            const numerator = `${match[1]} ${match[2].toLowerCase()}`;
            return match[4] ? `${numerator}/${match[3] ? `${match[3]} ` : ''}${match[4].toLowerCase()}` : numerator;
        }
        if (rule.name === 'UnquotedForm') {
            return node.text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ').replace(/\s+/g, ' ').trim();
        }
        return super.runConverter(rule, input, node);
    }
}
