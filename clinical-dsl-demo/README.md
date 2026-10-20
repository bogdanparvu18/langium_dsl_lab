# Clinical DSL Demo

A Langium-based external domain-specific language for declaring patients, medications, and named plans, with a VS Code language extension and a small JavaScript generator.

> **Scope:** This README describes the `clinical-dsl-demo/` subproject of `langium_dsl_lab`, not the other learning examples in the repository. The clinical example demonstrates software-language concepts; it is not a prescribing tool or a source of medical advice.

### Colon syntax and contextual help

Use `:` after the declaration name and commas between fields. Names remain identifiers; product strength and multiword dose forms do not need quotes in colon syntax.

```text
Patient DemoPatient: age 30, condition DemoCondition
Medication aspirin: 15 mg, strength 325 mg, doseForm Oral Tablet, route PO, frequency PRN
Plan DemoPlan: for DemoPatient, prescribe aspirin
show DemoPlan
```

This is a syntax example, not a treatment recommendation. `15 mg` is the administered amount; `325 mg` is the product strength. `route` and `frequency` are required. Supply both `strength` and `doseForm`, or omit both.

In a writable `.clinical` editor:

1. Press **Ctrl+Space** for completion suggestions.
2. Press **?** for help based on the text before the cursor: declaration name, amount, strength, dose form, route, frequency, patient, plan, or `show`.
3. Choose **Show suggestions** in the help message to open completion at that position.

The command is **Clinical DSL: Context Help (?)** in the Command Palette. Its default keybinding is **Shift+/**; on other keyboard layouts, rebind that command in Keyboard Shortcuts. The shortcut consumes the key without inserting `?`: it is editor help, not part of the grammar, saved document, or JSON sent to Scala. A question mark pasted into the source is not automatically removed and can cause a syntax error.

Lowercase `patient`, `medication`, and `plan` remain accepted, as do legacy brace declarations. `show` stays lowercase. Completion provides local language suggestions; it does not query RxNorm on every keystroke.

The AST/JSON contract is unchanged. The bridge still exports the plans selected by `show`, preserving source positions. No PostgreSQL reimport is needed for the syntax/help update.

## Executive summary

Clinical DSL Demo demonstrates how a small, explicitly defined language can turn structured text into a linked model that other software can process. A user writes a `.clinical` document containing patient declarations, medication declarations, plans that reference those declarations, and optional `show` statements that reference plans. Langium uses the grammar to build an abstract syntax tree (AST), resolve named references, and produce diagnostics.

The implementation is divided into three npm workspace packages. The **language package** contains the grammar, service configuration, and custom patient-name, dose-amount, and product-qualifier validators. The **extension package** connects the language services to VS Code through a Node.js language client and server. The **CLI package** reads and validates a document, then generates a JavaScript file containing a console message for each defined plan.

The project's value is the separation of **syntax**, **relationships**, **validation**, and **output generation**. It demonstrates the infrastructure needed to formalize a small domain, rather than a complete clinical application. It does not interpret natural-language notes, recommend treatments, check clinical suitability, or execute prescriptions. Although `show` is part of the grammar, the current generator iterates over every plan and does not use `show` to select output.

Implementation sources: [grammar][grammar], [service module][services], [validator][validator], [extension client][client], and [CLI generator][generator].

## 1. What the language represents

| Construct | Information captured | Relationship or behavior |
| --- | --- | --- |
| `patient` | A name, age token, and condition identifier | Creates a named `Patient` node. |
| `medication` | A name, numeric amount, unit, optional product qualifiers, route, and frequency | Creates a named `Medication` node. |
| `plan` | A name, one patient reference, and one medication reference | Links an existing patient to an existing medication. |
| `show` | A reference to a named plan | Creates a `DisplayPlan` node; the generator does not currently consume it. |

A plan records a relationship supplied by the author. It does not establish that the medication is appropriate for the patient. Conditions are identifiers. Units, routes, and frequencies are grammar-defined choices; product terminology is resolved separately through the Scala/RxNorm integration.

## 2. Example document and actual generated output

An example using the current colon syntax (see also [examples/colon-help.clinical](examples/colon-help.clinical)):

```text
Patient John: age 45, condition Diabetes
Medication Metformin: 500 mg, route PO, frequency BID
Plan DiabetesPlan: for John, prescribe Metformin
show DiabetesPlan
```


This is an example of the project's syntax, not a treatment recommendation. `John`, `Metformin`, and `DiabetesPlan` are names declared in the document. `for John`, `prescribe Metformin`, and `show DiabetesPlan` refer back to those declarations.

For this input, the [current generator][generator] produces:

```javascript
"use strict";
console.log("Plan DiabetesPlan for John");
```

Running that JavaScript prints:

```text
Plan DiabetesPlan for John
```

This output is derived from the generator's implementation. It is deliberately limited: it includes the plan name and patient name, but not the condition, medication name, or dose.

**The JavaScript CLI does not use `show` to select output.** Removing `show DiabetesPlan` from an otherwise valid document does not remove the console message. The generator loops over `model.plan`, not `model.display`. Conversely, an unresolved `show` reference can still cause a linking diagnostic and prevent the CLI from generating output, because validation happens before generation.

## 3. How the grammar is written

The language is defined in [`packages/language/src/clinical-dsl.langium`][grammar]. It uses Langium's grammar notation: EBNF-style grouping, alternatives, and repetition, extended with assignments that populate AST properties and typed cross-references.

### Complete grammar

```langium
grammar ClinicalDSLDemo

entry Model:
    (
        patient+=Patient |
        medication+=Medication |
        plan+=Plan |
        display+=DisplayPlan 
    )*;

Patient:
    ('patient' | 'Patient') name=ID
    ('{' 'age' age=INT 'condition' condition=ID '}'
    | ':' 'age' age=INT ',' 'condition' condition=ID);

Medication:
    ('medication' | 'Medication') name=ID
    ('{'
        amount=DoseAmount unit=Unit
        ('strength' productStrength=STRING)?
        ('doseForm' doseForm=STRING)?
        'route' route=Route 'frequency' frequency=Frequency
    '}'
    | ':' amount=DoseAmount unit=Unit
        (',' 'strength' productStrength=UnquotedStrength)?
        (',' 'doseForm' doseForm=UnquotedForm)?
        ',' 'route' route=Route ',' 'frequency' frequency=Frequency);

UnquotedStrength returns string:
    (DECIMAL | INT) ('mg' | 'mcg' | 'g')
    ('/' (DECIMAL | INT)? 'ml')?;

UnquotedForm returns string:
    ID+;

Plan:
    ('plan' | 'Plan') name=ID
    ('{' 'for' patient=[Patient] 'prescribe' medication=[Medication] '}'
    | ':' 'for' patient=[Patient] ',' 'prescribe' medication=[Medication]);

DisplayPlan:
    'show' plan=[Plan:ID];

// Keep the quantity numeric.
// Suggested/allowed quantities are configured separately.
DoseAmount returns number:
    DECIMAL | INT;

Unit returns string:
    'mg'
    | 'mcg'
    | 'g'
    | 'ml'
    | 'puff'
    | 'unit';

Route returns string:
    'PO'
    | 'IV'
    | 'IM'
    | 'SC'
    | 'PR'
    | 'SL'
    | 'BUCC';

Frequency returns string:
    'QD'
    | 'BID'
    | 'TID'
    | 'QID'
    | 'PRN'
    | 'Q4H'
    | 'Q6H'
    | 'Q8H'
    | 'Q12H'
    | 'Q24H';


hidden terminal WS: /\s+/;

hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;

// DECIMAL must precede INT.
terminal DECIMAL returns number: /[0-9]+\.[0-9]+/;
terminal INT returns number: /[0-9]+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;
terminal ID: /[_a-zA-Z][\w_]*/;
```

### Reading the notation

| Notation in this grammar | Meaning |
| --- | --- |
| `entry Model` | Parsing starts at `Model`. |
| `'patient'`, `'age'`, `'{'` | Literal tokens expected in the input. |
| `name=ID` | Assigns one identifier to a property named `name`. |
| `patient+=Patient` | Appends a parsed `Patient` to an array property named `patient`. |
| `A \| B` | Allows an alternative. |
| `(...)*` | Allows zero or more repetitions of the group. |
| `[Patient]`, `[Medication]`, `[Plan:ID]` | Reference an existing node of the indicated type instead of declaring a new one. |
| `hidden terminal WS` | Recognizes whitespace without making it part of the domain model. |

The [Langium grammar reference][langium-reference] explains the notation; the rules above define this project's particular language.

### 3.1 The document root: `Model`

The repeated group accepts any sequence of patient, medication, plan, and display statements. Because it uses `*`, an empty document is also permitted by the grammar. There is no grammar-level requirement to declare at least one patient or plan.

The root has four array properties:

```text
Model.patient[]
Model.medication[]
Model.plan[]
Model.display[]
```

The property names are singular in the source, but `+=` makes them collections. The generator therefore correctly accesses `model.plan`, not `model.plans`.

Top-level statement kinds can be interleaved. Inside each block, however, fields appear in the fixed order defined by its rule.

### 3.2 Patient declarations

The `Patient` rule requires a name, an `age` field, and then a `condition` field. Use colon/comma syntax or legacy braces:

```text
patient Alice {
    age 40
    condition ExampleCondition
}
```

`Alice` becomes the node's `name`. The age must match `INT`; the condition must match `ID`. The rule does not allow multiple conditions, optional age, or an arbitrary free-text description.

Changing the order to `condition ... age ...` does not satisfy the rule. Line breaks and indentation are flexible because whitespace is hidden; field order is not.

### 3.3 Medication declarations

```text
Medication DemoMedication: 2.5 mg, strength 10 mg/ml, doseForm Oral Solution, route PO, frequency PRN
```

Fields have a fixed order: amount and unit, optional strength, optional dose form, required route, required frequency. The validators require a positive finite dose amount and require the two product qualifiers together. Completion examples such as `1`, `2.5`, and `10` are suggestions, not the allowed-dose list.

| Field | Accepted syntax |
| --- | --- |
| Amount | Integer or decimal, such as `15` or `2.5`. |
| Unit | `mg`, `mcg`, `g`, `ml`, `puff`, `unit`. |
| Unquoted strength | Positive mass in `mg`, `mcg`, or `g`, optionally per `ml`, e.g. `10 mg/ml` or `50 mg/5 ml`. |
| Unquoted dose form | One or more identifier words, e.g. `Oral Tablet`. |
| Route | `PO`, `IV`, `IM`, `SC`, `PR`, `SL`, `BUCC`. |
| Frequency | `QD`, `BID`, `TID`, `QID`, `PRN`, `Q4H`, `Q6H`, `Q8H`, `Q12H`, `Q24H`. |

The [value converter](packages/language/src/clinical-dsl-value-converter.ts) preserves word separation in unquoted values. Legacy syntax is still supported, with quoted product qualifiers and no `dose` keyword:

```text
medication DemoMedication {
    2.5 mg
    strength "10 mg/ml"
    doseForm "Oral Solution"
    route PO
    frequency PRN
}
```

### 3.4 Plans and typed cross-references

A `Plan` contains exactly one patient reference followed by exactly one medication reference:

```text
plan ExamplePlan {
    for Alice
    prescribe DemoMedication
}
```

The grammar uses:

```langium
'for' patient=[Patient]
'prescribe' medication=[Medication]
```

These assignments do not create another patient or medication. They create references whose targets must be nodes of the appropriate type. The omitted token in `[Patient]` is inferred from the target's `name` assignment; here that is `name=ID`. Thus `[Patient]` and `[Patient:ID]` express the same token choice for this particular rule. The same applies to `[Medication]`.

For example, `for MissingPatient` can have a syntactically valid identifier while still failing reference resolution. The [service module][services] uses Langium's default services rather than implementing a separate custom linker.

### 3.5 Display statements

```text
show ExamplePlan
```

creates a `DisplayPlan` whose `plan` property references a `Plan`. `[Plan:ID]` specifies the reference token explicitly.

The editor uses `show` for plan previews and the Scala bridge uses it to select plans for export and RxNorm resolution. The separate JavaScript [generator][generator] still iterates over all plans.

### 3.6 Lexical rules and practical syntax limits

`ID` starts with an ASCII letter or underscore, followed by word characters or underscores. Names such as `Alice`, `Plan_1`, and `DemoMedication` fit that pattern; `Alice Smith`, `Plan-1`, and a quoted name do not fit a single `ID`.

`INT` accepts digits and returns a number; `DECIMAL` accepts digits on both sides of a decimal point and also returns a number. `DoseAmount` accepts either. Negative amounts are not part of the grammar.

Line comments (`// ...`), block comments (`/* ... */`), and whitespace are hidden. The `STRING` terminal supports quoted values in legacy brace syntax. Colon syntax uses unquoted strength and dose form rules.

Keywords are case-sensitive, with explicit lowercase/title-case alternatives for patient, medication, and plan declarations. Semicolons belong to the grammar specification, not to user documents. Newlines are whitespace, so a declaration can wrap across lines; commas and field order still matter.

## 4. From text to a linked AST

For the included example, the model can be understood as:

```text
Model
├── patient[0]       Patient named John
├── medication[0]    Medication named Metformin
├── plan[0]          Plan named DiabetesPlan
│   ├── patient  ──► Patient John
│   └── medication ► Medication Metformin
└── display[0]       DisplayPlan
    └── plan     ──► Plan DiabetesPlan
```

This is a conceptual sketch, not a JSON serialization. The arrows represent references, not duplicated declarations or ownership of the referenced nodes.

The implementation separates two forms of generation:

**Language-infrastructure generation:** `npm run langium:generate` reads the grammar configuration and writes the generated AST definitions, grammar representation, and service modules under `packages/language/src/generated/`.

**Application-output generation:** the CLI takes a parsed `Model` and calls `generateJavaScript(...)` to write a plan-summary `.js` file.

Those are different operations. Writing a parser rule makes a structure available to the AST; application code must still decide what to do with it. See [Langium configuration][langium-config], [service assembly][services], and [output generation][generator].

The project also uses several intentionally distinct names:

| Setting | Current value |
| --- | --- |
| Grammar declaration | `ClinicalDSLDemo` |
| Generator `projectName` | `ClinicalDsl` |
| VS Code language ID | `clinical-dsl` |
| VS Code language label | `Clinical DSL` |
| Document extension | `.clinical` |

These values come from the [grammar][grammar], [Langium configuration][langium-config], and [extension manifest][extension-manifest].

## 5. Validation: what is checked and what is not

The [CLI document loader][cli-util] builds the document with validation enabled before extracting its AST. The language services also register the [custom validator][validator]. There are three distinct concerns:

| Layer | Example | Result to expect from the implementation |
| --- | --- | --- |
| Syntax | `age forty` where the rule requires `INT` | A parsing diagnostic. |
| Reference resolution | A plan refers to an undeclared patient | A linking diagnostic. |
| Custom validation | A patient is named `john` | A capitalization warning. |

Registered checks include positive finite medication amounts, paired product qualifiers with supported positive strength syntax, and `Patient: checkPatientStartsWithCapital`. It checks whether the first character differs from its uppercase form and reports:

```text
Patient name should start with a capital letter.
```

This is a **warning**, not an error. An initial underscore does not trigger that comparison, so the rule is not a strict requirement that every name begin with an uppercase alphabetic character.

The CLI filters diagnostics for severity `1` and exits when such errors exist. Its current document loader does not print or reject warnings. Therefore, a capitalization warning alone does not block generation.

No clinical checks are implemented for age bounds, dose safety, or medication–condition compatibility. Units are constrained by the grammar; the Scala bridge also rejects duplicate declarations. Syntactic validity and successful linking must not be interpreted as clinical correctness.

## 6. Project structure

```text
clinical-dsl-demo/
├── package.json                         Workspace scripts and package membership
├── tsconfig.build.json                  Whole-workspace TypeScript build
├── .vscode/launch.json                  Extension/server debugging configurations
└── packages/
    ├── language/
    │   ├── langium-config.json           Grammar input and generated-output settings
    │   ├── src/
    │   │   ├── clinical-dsl.langium      Language syntax and AST assignments
    │   │   ├── clinical-dsl-module.ts    Default, generated, and custom services
    │   │   ├── clinical-dsl-validator.ts Patient-name, amount, and qualifier checks
    │   │   ├── index.ts                  Public exports
    │   │   └── generated/                Created by Langium generation
    │   └── test/                         Clinical grammar and validation tests
    ├── extension/
    │   ├── package.json                  .clinical registration and extension entry
    │   ├── esbuild.mjs                   Bundles extension and server for Node.js
    │   └── src/
    │       ├── extension/main.ts         Starts/stops the language client
    │       └── language/main.ts          Starts the Langium language server
    └── cli/
        ├── bin/cli.js                    Executable wrapper
        └── src/
            ├── main.ts                  Defines the generate command
            ├── util.ts                  Loads, builds, and validates documents
            ├── generator.ts             Writes JavaScript plan summaries
            └── demo.clinical             Included example document
```

`createClinicalDslServices(...)` combines Langium defaults, generated modules, and `ClinicalDslModule`; registers the language; and registers the custom validators, completion provider, and value converter. Both the CLI and the language server use this service factory. The extension client communicates with its Node.js server using IPC. Sources: [services][services], [CLI entry][cli-main], [client][client], [server][server].

## 7. Build and run

### Requirements declared in the repository

The language and CLI package manifests declare Node.js `>=20.10.0` and npm `>=10.2.3`. The extension declares VS Code `^1.91.0`. Langium and `langium-cli` are specified as `~4.4.0`. These are the package declarations, not a guarantee that every resolved dependency accepts the minimum Node version; also check installation-time engine messages and the lockfile.

Sources: [language package][language-package], [CLI package][cli-package], and [extension manifest][extension-manifest].

### Prepare the workspace

From the repository root:

```bash
cd clinical-dsl-demo
npm ci
npm run langium:generate
npm run build
```

Run these steps in order and stop if a command fails. The root build compiles the TypeScript projects and invokes the workspace build scripts. The extension build also copies the TextMate grammar and runs esbuild. Its two bundled entry points are:

```text
packages/extension/out/extension/main.cjs
packages/extension/out/language/main.cjs
```

The language and CLI package scripts printing `No build step` do not mean those packages are unused: their TypeScript compilation is handled by the root build. See [workspace scripts][workspace-package] and [extension bundling][esbuild].

### Generate and execute the demo output

From `clinical-dsl-demo/`, after a successful build:

```bash
node packages/cli/bin/cli.js generate examples/colon-help.clinical -d generated
node generated/colon-help.js
```

The first command parses, links, and validates the document before writing `generated/colon-help.js`. The second command executes that generated JavaScript. Without `-d`, the generator writes the output beside the input file, with the same base name and a `.js` extension. It writes to that path directly, replacing existing contents if the file already exists.

These commands reflect the [CLI wrapper][cli-wrapper], [command registration][cli-main], [validation gate][cli-util], and [generator][generator].

### Use the VS Code language extension

Open **`clinical-dsl-demo` itself** as the source workspace, complete the build, and select **Run Extension** from [.vscode/launch.json][launch]. In the Extension Development Host, open the included `.clinical` document and check that its language mode is **Clinical DSL**.

The extension is configured to activate for `clinical-dsl` documents and start the Langium server. Language registration, successful extension activation, and working diagnostics are separate checks. A missing `out/extension/main.cjs` prevents activation even when the document's language label is visible.

The manifest does not contribute a debugger for executing `.clinical` documents. Use the development host to edit and inspect them; use the CLI commands above to generate and run the demo's JavaScript output. See [extension manifest][extension-manifest] and [client startup][client].

## 8. Development scripts and current test status

For changes to the grammar, regenerate and rebuild. For TypeScript-only changes, rebuild. Editing only a `.clinical` document does not require regenerating the language infrastructure.

The existing scripts also provide separate watch stages:

| Command, run from `clinical-dsl-demo/` | What it watches |
| --- | --- |
| `npm run langium:watch` | Grammar generation. |
| `npm run watch` | Workspace TypeScript compilation. |

The bundler is the third stage. Run it in a separate terminal from the extension directory, because its input paths are relative to that directory:

```bash
cd packages/extension
node esbuild.mjs --watch
```

The root TypeScript watcher alone does not regenerate the grammar or rebuild the extension bundles. After grammar changes, the TextMate file must also be copied into the extension package; the existing command from the workspace root is:

```bash
npm run --workspace packages/extension build:prepare
```

These processes update files on disk, not JavaScript already loaded into a running host. Reload the development host after successful compilation to test the new implementation. The scripts do not implement automatic runtime hot replacement. Sources: [workspace scripts][workspace-package], [language scripts][language-package], [extension scripts][extension-manifest], and [esbuild][esbuild].

### Language and extension tests

After regenerating and building, run from `clinical-dsl-demo/`:

```bash
npm test
node --test packages/extension/test/context-help.test.mjs packages/extension/test/rxnorm.test.mjs
```

The language suite covers clinical syntax and validation, including colon syntax, unquoted qualifiers, and legacy compatibility. The extension suites cover contextual help and RxNorm process/preview behavior using mocks. These tests do not replace a visual check in Extension Development Host.

Open `examples/colon-help.clinical` from the same checkout in the development host. Try Ctrl+Space and `?` at different field positions; confirm that help does not insert a question mark. Reload the host after rebuilding.

For AST export tests, follow the [Scala repository README](https://github.com/bogdanparvu18/scala-testing-lab#12-testing), setting `LANGIUM_ROOT` to this compiled workspace.

## 9. Current implementation boundaries

- The JavaScript CLI prints all plan/patient summaries. The editor and Scala bridge use `show` to select plans.
- Grammar validation is structural, not a clinical dose-safety check.
- The extension can resolve terminology through the companion Scala CLI and local PostgreSQL RxNorm database. Resolution runs on save or an explicit command; contextual help and completion are local editor features.
- The JSON contract retains separate administered dose and product-strength fields. Changing the surface syntax does not change the Scala schema or require importing the terminology database again.

See [COLON-HELP.md](COLON-HELP.md) for the syntax/help change and the [Scala README](https://github.com/bogdanparvu18/scala-testing-lab#10-vs-code-extension-workflow) for resolver configuration.

[grammar]: packages/language/src/clinical-dsl.langium
[langium-config]: packages/language/langium-config.json
[services]: packages/language/src/clinical-dsl-module.ts
[validator]: packages/language/src/clinical-dsl-validator.ts
[language-package]: packages/language/package.json
[workspace-package]: package.json
[extension-manifest]: packages/extension/package.json
[client]: packages/extension/src/extension/main.ts
[server]: packages/extension/src/language/main.ts
[esbuild]: packages/extension/esbuild.mjs
[cli-main]: packages/cli/src/main.ts
[cli-util]: packages/cli/src/util.ts
[generator]: packages/cli/src/generator.ts
[cli-package]: packages/cli/package.json
[cli-wrapper]: packages/cli/bin/cli.js
[demo]: packages/cli/src/demo.clinical
[validation-tests]: packages/language/test/validating.test.ts
[launch]: .vscode/launch.json
[langium-reference]: https://langium.org/docs/reference/grammar-language/
