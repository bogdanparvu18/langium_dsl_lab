import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('selective keyword highlighting', () => {
    test('matches parser keyword casing while preserving Patient keyword rules', () => {
        const directory = mkdtempSync(join(tmpdir(), 'clinical-highlighting-'));
        const target = join(directory, 'grammar.json');
        try {
            writeFileSync(target, JSON.stringify({patterns: [{
                name: 'keyword.control.clinical-dsl',
                match: '\\b(medication|plan|show|doseForm|dose|route|PO|IV|mg|BID|patient|Patient|age|condition)\\b'
            }]}));
            const script = fileURLToPath(new URL('../scripts/update-textmate.mjs', import.meta.url));
            execFileSync(process.execPath, [script, target]);
            const result = readFileSync(target, 'utf8');
            const regex = new RegExp(JSON.parse(result).patterns[0].match);
            for (const word of ['Medication', 'mEdIcAtIoN', 'Plan', 'PLAN', 'SHOW', 'DoseForm', 'Po', 'iv', 'MG', 'bId']) {
                expect(regex.test(word), word).toBe(true);
            }
            for (const word of ['patient', 'Patient', 'age', 'condition']) expect(regex.test(word), word).toBe(true);
            for (const word of ['PATIENT', 'Age', 'Condition', 'medicationExtra']) expect(regex.test(word), word).toBe(false);
            execFileSync(process.execPath, [script, target]);
            expect(readFileSync(target, 'utf8')).toBe(result);
        } finally {
            rmSync(directory, {recursive: true, force: true});
        }
    });

    test('the generated grammar uses the transformed case-aware pattern', () => {
        const grammar = JSON.parse(readFileSync(new URL('../syntaxes/clinical-dsl.tmLanguage.json', import.meta.url), 'utf8'));
        const regex = new RegExp(grammar.patterns.find((pattern: {name?: string}) => pattern.name === 'keyword.control.clinical-dsl').match);
        expect(regex.test('mEdIcAtIoN')).toBe(true);
        expect(regex.test('Plan')).toBe(true);
        expect(regex.test('DOSEFORM')).toBe(true);
        expect(regex.test('PATIENT')).toBe(false);
    });
});
