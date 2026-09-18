import fs from 'node:fs';
import path from 'node:path';
import type { Model } from 'clinical-dsl-language';

function extractDestinationAndName(
    filePath: string,
    destination: string | undefined
): { destination: string; name: string } {
    const fileName = path.basename(filePath);
    return {
        destination: destination ?? path.dirname(filePath),
        name: path.basename(fileName, path.extname(fileName))
    };
}

export function generateJavaScript(
    model: Model,
    filePath: string,
    destination: string | undefined
): string {

    const data = extractDestinationAndName(filePath, destination);
    const generatedFilePath =
        `${path.join(data.destination, data.name)}.js`;

    const lines: string[] = [
        '"use strict";'
    ];

    for (const plan of model.plan) {
        const patientName =
            plan.patient.ref?.name ?? 'UnknownPatient';

        lines.push(
            `console.log("Plan ${plan.name} for ${patientName}");`
        );
    }

    if (!fs.existsSync(data.destination)) {
        fs.mkdirSync(data.destination, {
            recursive: true
        });
    }

    fs.writeFileSync(
        generatedFilePath,
        lines.join('\n')
    );

    return generatedFilePath;
}