import { readFile, writeFile } from 'node:fs/promises';

// The runtime TokenBuilder makes only Medication/Plan keywords insensitive to
// case. Langium's language-wide caseInsensitive switch would also change Patient.
// Apply the same selective rule to its generated TextMate keyword pattern.
const filename = process.argv[2] ?? new URL('../syntaxes/clinical-dsl.tmLanguage.json', import.meta.url);
const grammar = JSON.parse(await readFile(filename, 'utf8'));
const pattern = grammar.patterns.find(pattern => pattern.name === 'keyword.control.clinical-dsl');
if (!pattern || typeof pattern.match !== 'string') throw new Error('Generated keyword pattern was not found.');
const fixed = new Set(['patient', 'Patient', 'age', 'condition']);
if (/^\\b\([A-Za-z0-9_|]+\)\\b$/.test(pattern.match)) {
    const keywords = pattern.match.slice(3, -3).split('|');
    pattern.match = '\\b(' + keywords.map(word => fixed.has(word) ? word :
        word.replace(/[a-z]/gi, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`)).join('|') + ')\\b';
    await writeFile(filename, JSON.stringify(grammar, null, 2) + '\n');
} else if (!/^\\b\((?:\[[a-z][A-Z]\]|[A-Za-z0-9_|])+\)\\b$/.test(pattern.match)) {
    throw new Error('Generated keyword pattern changed; update the selective case handling.');
}
