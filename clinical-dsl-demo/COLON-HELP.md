# Colon syntax and contextual help

Rebuild the Langium workspace after pulling both repositories:

```sh
cd clinical-dsl-demo
npm ci
npm run langium:generate
npm run build
npm test
```

Launch the extension using F5 and open `examples/colon-help.clinical` in the Extension Development Host.

```text
Patient DemoPatient: age 30, condition DemoCondition
Medication aspirin: frequency prn, dose 15mg, strength 325mg, doseForm Oral Tablet, route po
Plan DemoPlan: prescribe aspirin, for DemoPatient
show DemoPlan
```

These values illustrate syntax only. Dose and product strength are different fields.

Press **? (Shift+/ on a US keyboard)** while editing a `.clinical` file. The extension consumes the key before text insertion and shows help for the cursor position. Dismiss the message to continue, or select **Show suggestions**. You can also use Ctrl+Space for ordinary completion. On another keyboard layout, bind **Clinical DSL: Context Help (?)** to the key that produces `?` in VS Code Keyboard Shortcuts; the command is also available from the Command Palette. A question mark pasted into a file is not valid DSL and is never silently stripped by the exporter.

In the colon form, medication fields and plan references can be written in any order, with or without commas. Medication and plan keywords, recognized units, routes and frequencies accept different letter case. `15mg` and `15 mg` are equivalent; the label `dose` is optional. `strength` and `doseForm` are optional together; a complete medication still needs a dose, route and frequency. Multiword forms such as `Oral Tablet` need no quotes. Identifiers use letters, digits and underscores, starting with a letter or underscore. The patient declaration retains its existing syntax; connecting to Aurora PCM is future work.

For a concrete hint, place the cursor after `Medication aspirin: dose 15mg,` and press **?**. The help identifies missing fields and shows examples such as `route PO` and `frequency BID`; it does not insert the question mark. Help is local and includes examples for medication and plan fields.

Positive numeric doses are accepted; the old demo list is no longer a validation constraint. Existing completion examples remain a fictional demo catalog, not live RxNorm suggestions. Product resolution still runs on save or through the RxNorm command using the configured Scala/PostgreSQL installation. No database connection is needed for syntax help.

The exported JSON contract is unchanged. Rebuild Langium before running Scala bridge tests:

```sh
LANGIUM_ROOT=/absolute/path/to/langium_dsl_lab/clinical-dsl-demo node --test bridge/export-ast.test.mjs
```

Run that command from `scala-testing-lab`. Actual RxNorm resolution requires your local terminology snapshot and PostgreSQL settings.
