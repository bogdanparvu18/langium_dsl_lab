import { readFile } from 'node:fs/promises';
import { createServicesForGrammar } from 'langium/grammar';
import { parseHelper } from 'langium/test';
import { registerClinicChecks } from './validation.mjs';

const args = process.argv.slice(2);
const customChecks = args.includes('--clinic-checks');
const files = args.filter(arg => arg !== '--clinic-checks');
if (files.length !== 2) {
    console.error('Usage: node inspect.mjs GRAMMAR CONTENT [--clinic-checks]');
    process.exit(2);
}
const grammar = await readFile(files[0], 'utf8');
const input = await readFile(files[1], 'utf8');
// Helper din Langium pentru experimente cu gramatici dinamice.
// Un proiect de productie poate folosi serviciile generate ale limbajului.
const services = await createServicesForGrammar({ grammar });
if (customChecks) registerClinicChecks(services);
const document = await parseHelper(services)(input, { validation: true });
const diagnostics = document.diagnostics ?? [];
console.log(JSON.stringify({
    lexerErrors: document.parseResult.lexerErrors.length,
    parserErrors: document.parseResult.parserErrors.length,
    diagnostics: diagnostics.map(item => ({
        severity: item.severity,
        line: item.range.start.line + 1,
        message: item.message
    }))
}, null, 2));
console.log(services.serializer.JsonSerializer.serialize(
    document.parseResult.value, { space: 2, refText: true }
));
if (document.parseResult.lexerErrors.length ||
    document.parseResult.parserErrors.length ||
    diagnostics.some(item => item.severity === 1)) {
    process.exitCode = 1;
}
