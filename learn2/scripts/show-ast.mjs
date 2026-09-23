import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EmptyFileSystem } from 'langium';
import { createMedicationServices } from '../packages/language/out/medication-module.js';

const source = resolve(process.argv[2] ?? 'examples/valid.med');
const input = await readFile(source, 'utf8');
const services = createMedicationServices(EmptyFileSystem).Medication;
const result = services.parser.LangiumParser.parse(input);

const errors = [...result.lexerErrors, ...result.parserErrors];
if (errors.length > 0) {
    for (const error of errors) {
        console.error(error.message);
    }
    process.exitCode = 1;
} else {
    // Alegem campurile utile: nodurile Langium contin si legaturi interne
    // ($container, $cstNode) care nu sunt destinate serializarii ca JSON.
    const model = result.value;
    const printable = {
        $type: model.$type,
        orders: model.orders.map(order => ({
            $type: order.$type,
            name: order.name,
            dosage: {
                $type: order.dosage.$type,
                value: order.dosage.value,
                unit: order.dosage.unit,
                ...(order.dosage.form ? { form: order.dosage.form } : {})
            },
            route: order.route,
            frequency: order.frequency
        }))
    };
    console.log(JSON.stringify(printable, null, 2));
}
