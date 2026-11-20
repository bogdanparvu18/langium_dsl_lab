import { describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { createClinicalDslServices } from '../src/clinical-dsl-module.js';
import { monographSourceEdits, readMonographSource } from '../src/monograph-source.js';

import type { Model } from '../src/generated/ast.js';

const parser = createClinicalDslServices(EmptyFileSystem).ClinicalDsl.parser.LangiumParser;
const parse = (s: string) => parser.parse<Model>(s).value;
const source = { din: '00012345', sha256: 'a'.repeat(64), rxcui: '900001', release: '2026-10-05' };
const declaration = 'Medication Morning: product "Example 20 MG Oral Tablet" rxcui "900001" dose 20 mg frequency 4-6H PRN';
const marker = `// @monograph Morning ${source.rxcui} ${source.release} ${source.din} ${source.sha256}`;
const apply = (text: string, index: number) => {
    const edits = monographSourceEdits(parse(text).medication[index], source);
    return [...edits].reverse().reduce((s, edit) => s.slice(0, edit.start) + edit.text + s.slice(edit.end), text);
};

describe('portable product monograph reference', () => {
    test('inserts the source ahead of the declaration and round-trips first and indented orders', () => {
        for (const newline of ['\n', '\r\n']) {
            for (const lead of ['', `// user note 💊${newline}  `]) {
                const original = lead + declaration + newline;
                const saved = apply(original, 0);
                expect(saved).toBe(lead + marker + newline + (lead ? '  ' : '') + declaration + newline);
                expect(readMonographSource(parse(saved).medication[0])).toEqual({status:'selected', source});
                expect(apply(saved, 0)).toBe(saved);
            }
        }
    });

    test('only associates a preceding comment token with its own bound medication', () => {
        const other = declaration.replace('Morning:', 'Evening:');
        const text = declaration + '\n' + marker.replace('Morning', 'Evening') + '\n// separate note\n' + other;
        const [first, second] = parse(text).medication;
        expect(readMonographSource(first).status).toBe('missing');
        expect(readMonographSource(second)).toEqual({status:'selected', source});
        for (const prefix of [`/* ${marker} */\n`, `${declaration} ${marker}\n`]) {
            expect(readMonographSource(parse(prefix + other).medication.at(-1)!).status).toBe('missing');
        }
    });

    test('rejects stale, malformed and duplicate references; reselection replaces only reserved metadata', () => {
        for (const head of [marker.replace('Morning','Evening'), marker.replace('900001','900002'),
            '// @monograph broken', marker + '\n' + marker]) {
            const text = head + '\n// clinical note\n' + declaration;
            expect(readMonographSource(parse(text).medication[0]).status).toBe('invalid');
            const repaired = apply(text, 0);
            expect(readMonographSource(parse(repaired).medication[0])).toEqual({status:'selected', source});
            expect(repaired).toContain('// clinical note\n' + declaration);
        }
    });
});
