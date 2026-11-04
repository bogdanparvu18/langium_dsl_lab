# Colon syntax and contextual help

Rebuild the Langium workspace after pulling the PR branch:

```sh
cd clinical-dsl-demo
npm ci
npm run langium:generate
npm run build
npm test
node --test packages/extension/test/context-help.test.mjs packages/extension/test/rxnorm.test.mjs packages/extension/test/language-server-flow.test.mjs
```

Launch the extension using F5 and open `examples/colon-help.clinical` in the Extension Development Host.
Use `examples/flexible-colon.clinical` for a mixed-case, reordered example with quoted values and keyword-looking names.

```text
Patient DemoPatient: age 30, condition DemoCondition
Medication aspirin: frequency prn, dose 15mg, strength 325mg, doseForm Oral Tablet, route po
Plan DemoPlan: prescribe aspirin, for DemoPatient
show DemoPlan
```

These values illustrate syntax only. Dose and product strength are different fields.

Press **? (Shift+/ on a US keyboard)** while editing a `.clinical` file. The extension consumes the key before text insertion and shows help for the cursor position. Dismiss the message to continue, or select **Show suggestions**. You can also use Ctrl+Space for ordinary completion. On another keyboard layout, bind **Clinical DSL: Context Help (?)** to the key that produces `?` in VS Code Keyboard Shortcuts; the command is also available from the Command Palette. A question mark pasted into a file is not valid DSL and is never silently stripped by the exporter.

In the colon form, medication fields and plan references can be written in any order, with or without commas. Medication and plan keywords, recognized units, routes and frequencies accept different letter case. `15mg` and `15 mg` are equivalent; the label `dose` is optional. `strength` and `doseForm` are optional together; a complete medication still needs a dose, route and frequency. Multiword forms such as `Oral Tablet` need no quotes. Identifiers use letters, digits and underscores, starting with a letter or underscore. The patient declaration retains its existing syntax; connecting to Aurora PCM is future work.

For a concrete hint, place the cursor after `Medication aspirin: dose 15mg,` and press **?**. The help identifies missing fields and shows examples such as `route PO` and `frequency BID`; it does not insert the question mark. Help parses the full declaration, so fields after the cursor count as present, while fields mentioned in comments do not. Plan examples use names declared in the document when available. Completion filters fields already present elsewhere while allowing an existing value to be edited.

Product strength and dose form can also be quoted: `strength "160MG/5ML"`, `doseForm "Metered Dose Inhaler"`. The latter also works without quotes; use quotes for other forms containing field keywords or ending in `Dose`. Keyword-looking names such as `Patient Po` retain their spelling. Patient field order and keyword casing remain unchanged.

An exact product selection persists as `rxcui "900001", rxnormRelease "2026-10-05"`, in either order. This numeric ID is a fictional syntax example; select an actual product from the RxNorm suggestions. Both fields are required together, accept mixed-case field labels, and use quoted values. RxCUI stays a string, and the release must be a valid calendar date. Press **?** after either field for a concrete example of the missing counterpart. The medication name remains the local alias used by Plan; selecting a product does not determine the administered dose or frequency. Optional `strength` and `doseForm` must agree with the bound product when supplied.

For a product search that preserves an existing alias, type a prefix inside the quoted RxCUI field, such as `rxcui "aspi"`, and accept a product with Tab (or first open the list with Ctrl+Space). The prefix is temporary editing text; export requires the numeric RxCUI inserted by selection. See [RxNorm product autocomplete](RXNORM-AUTOCOMPLETE.md) for the local service setup.

References are case-insensitive with local-first precedence. When no local declaration exists, two matching declarations in other files produce an ambiguity error; they are never selected by loading order. Adding, renaming or deleting a file refreshes dependent references.

Positive numeric doses are accepted; the old demo list is no longer a validation constraint. RxNorm product suggestions require the local search service described in [RXNORM-AUTOCOMPLETE.md](RXNORM-AUTOCOMPLETE.md). Product resolution still runs on save or through the RxNorm command using the configured Scala/PostgreSQL installation. No database connection is needed for syntax help.

Unbound declarations retain the existing JSON contract. Bound medications add `productBinding: { rxcui, release }`; bridge requests containing a binding use schema version `2` and policy `explicit-product-v1`. Update the companion Scala project before exporting bound declarations. Rebuild Langium before running Scala bridge tests:

```sh
LANGIUM_ROOT=/absolute/path/to/langium_dsl_lab/clinical-dsl-demo node --test bridge/export-ast.test.mjs
```

Run that command from `scala-testing-lab`. Actual RxNorm resolution requires your local terminology snapshot and PostgreSQL settings.
