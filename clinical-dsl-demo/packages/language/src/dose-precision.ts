import { GrammarUtils } from 'langium';
import type { Medication } from './generated/ast.js';

// Compare decimal spellings by their significant digits and their power of ten.
// Number.toString() can use scientific notation even when the clinician typed a decimal.
function decimalKey(text: string): string {
    const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    const digits = (whole + fraction).replace(/^0+/, '');
    if (!digits.length) return '0';
    let end = digits.length;
    while (digits[end - 1] === '0') end--;
    return digits.slice(0, end) + 'e' + (Number(exponent) - fraction.length + digits.length - end);
}

/** The numeric AST and JSON must retain the dose the clinician actually wrote. */
export function hasExactDoseValue(medication: Medication): boolean {
    if (medication.amount === undefined) return true;
    const literal = GrammarUtils.findNodeForProperty(medication.$cstNode, 'amount')?.text;
    return literal !== undefined && Number.isFinite(medication.amount) &&
        decimalKey(literal) === decimalKey(String(medication.amount));
}
