// Reguli didactice pentru acest exemplu. Limita 130 este o politica
// fictiva a aplicatiei, nu o regula medicala generala.
export function checkPatientAge(patient, accept) {
    if (patient.age > 130) {
        accept('error', 'Varsta depaseste limita didactica de 130.', {
            node: patient,
            property: 'age'
        });
    }
}

export function checkUniquePatientNames(model, accept) {
    const seen = new Set();
    for (const patient of model.patients ?? []) {
        if (seen.has(patient.name)) {
            accept('error', 'Numele pacientului este duplicat.', {
                node: patient,
                property: 'name'
            });
        }
        seen.add(patient.name);
    }
}

export function registerClinicChecks(services) {
    services.validation.ValidationRegistry.register({
        Patient: checkPatientAge,
        Model: checkUniquePatientNames
    });
}
