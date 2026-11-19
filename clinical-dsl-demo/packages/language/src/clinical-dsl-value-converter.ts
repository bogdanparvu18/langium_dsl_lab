import { DefaultValueConverter, ValueConverter, type CstNode, type GrammarAST, type ValueType } from 'langium';

import { normalizeFrequency } from './frequency.js';

/** Preserve word boundaries: Langium concatenates data-rule tokens by default. */
export class ClinicalDslValueConverter extends DefaultValueConverter {
    protected override runConverter(rule: GrammarAST.AbstractRule, input: string, node: CstNode): ValueType {
        // A keyword used as a name is not an enum value: retain its source spelling.
        if (rule.name === 'Identifier') return node.text.trim();
        if (rule.name === 'Unit') return input.toLowerCase();
        if (rule.name === 'Route') return input.toUpperCase();
        if (rule.name === 'Frequency') {
            const value = this.textValue(node);
            return normalizeFrequency(value) ?? value;
        }
        if (rule.name === 'ProductStrength' || rule.name === 'UnquotedStrength') {
            const text = this.textValue(node);
            const match = /^(\d+(?:\.\d+)?)\s*(mcg|mg|g)(?:\s*\/\s*(\d+(?:\.\d+)?)?\s*(ml))?$/i.exec(text);
            if (!match) return text;
            const numerator = `${match[1]} ${match[2].toLowerCase()}`;
            return match[4] ? `${numerator}/${match[3] ? `${match[3]} ` : ''}${match[4].toLowerCase()}` : numerator;
        }
        if (rule.name === 'ProductForm' || rule.name === 'UnquotedForm') {
            return this.textValue(node);
        }
        return super.runConverter(rule, input, node);
    }

    private textValue(node: CstNode): string {
        const raw = node.text.trim();
        // Comments inside a quoted value are literal text, not DSL comments.
        if (raw.startsWith('"') || raw.startsWith("'")) {
            return ValueConverter.convertString(raw).replace(/\s+/g, ' ').trim();
        }
        return raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ').replace(/\s+/g, ' ').trim();
    }
}
