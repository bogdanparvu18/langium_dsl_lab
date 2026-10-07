# Clinical DSL Demo

A Langium-based external domain-specific language for declaring patients, medications, and named plans, with a VS Code language extension and a small JavaScript generator.

> **Scope:** This README describes the `clinical-dsl-demo/` subproject of `langium_dsl_lab`, not the other learning examples in the repository. The clinical example demonstrates software-language concepts; it is not a prescribing tool or a source of medical advice.

## Executive summary

Clinical DSL Demo demonstrates how a small, explicitly defined language can turn structured text into a linked model that other software can process. A user writes a `.clinical` document containing patient declarations, medication declarations, plans that reference those declarations, and optional `show` statements that reference plans. Langium uses the grammar to build an abstract syntax tree (AST), resolve named references, and produce diagnostics.

The implementation is divided into three npm workspace packages. The **language package** contains the grammar, service configuration, and a custom patient-name validator. The **extension package** connects the language services to VS Code through a Node.js language client and server. The **CLI package** reads and validates a document, then generates a JavaScript file containing a console message for each defined plan.

The project's value is the separation of **syntax**, **relationships**, **validation**, and **output generation**. It demonstrates the infrastructure needed to formalize a small domain, rather than a complete clinical application. It does not interpret natural-language notes, recommend treatments, check clinical suitability, or execute prescriptions. Although `show` is part of the grammar, the current generator iterates over every plan and does not use `show` to select output.

Implementation sources: [grammar][grammar], [service module][services], [validator][validator], [extension client][client], and [CLI generator][generator].

## 1. What the language represents

| Construct | Information captured | Relationship or behavior |
| --- | --- | --- |
| `patient` | A name, age token, and condition identifier | Creates a named `Patient` node. |
| `medication` | A name, dose amount token, and unit identifier | Creates a named `Medication` node. |
| `plan` | A name, one patient reference, and one medication reference | Links an existing patient to an existing medication. |
| `show` | A reference to a named plan | Creates a `DisplayPlan` node; the generator does not currently consume it. |

A plan records a relationship supplied by the author. It does not establish that the medication is appropriate for the patient. Conditions and units are identifiers, not controlled clinical vocabularies. These boundaries follow directly from the [grammar][grammar] and the single rule in the [custom validator][validator].

## 2. Example document and actual generated output

The repository includes this document at [`packages/cli/src/demo.clinical`][demo]:

```text
patient John {
    age 45
    condition Diabetes
}

medication Metformin {
    dose 500 mg
}

plan DiabetesPlan {
    for John
    prescribe Metformin
}

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

**`show` is not an execution command in the current implementation.** Removing `show DiabetesPlan` from an otherwise valid document does not remove the console message. The generator loops over `model.plan`, not `model.display`. Conversely, an unresolved `show` reference can still cause a linking diagnostic and prevent the CLI from generating output, because validation happens before generation.

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
    'patient' name=ID '{'
        'age' age=INT
        'condition' condition=ID
    '}';

Medication:
    'medication' name=ID '{'
        'dose' amount=INT unit=ID
    '}';

Plan:
    'plan' name=ID '{'
        'for' patient=[Patient]
        'prescribe' medication=[Medication]
    '}';

DisplayPlan:
    'show' plan=[Plan:ID];

hidden terminal WS: /\s+/;

terminal ID:
    /[_a-zA-Z][\w_]*/;

terminal INT:
    /[0-9]+/;
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

The `Patient` rule requires a name, braces, an `age` field, and then a `condition` field:

```text
patient Alice {
    age 40
    condition ExampleCondition
}
```

`Alice` becomes the node's `name`. The age must match `INT`; the condition must match `ID`. The rule does not allow multiple conditions, optional age, or an arbitrary free-text description.

Changing the order to `condition ... age ...` does not satisfy the rule. Line breaks and indentation are flexible because whitespace is hidden; field order is not.

### 3.3 Medication declarations

The `Medication` rule requires exactly one dose amount and one unit:

```text
medication DemoMedication {
    dose 10 mg
}
```

The amount must match the digit-only `INT` token. The unit is an `ID`, not an enumeration. As a result, the grammar does not distinguish a recognized unit from an invented identifier. It also has no route, frequency, duration, or decimal-dose production.

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

Defining this statement in the grammar gives it syntax and a model representation. It does **not** implement display behavior. The [generator][generator] currently does not read these nodes, and the [extension manifest][extension-manifest] declares no custom VS Code command that executes `show`.

### 3.6 Lexical rules and practical syntax limits

`ID` starts with an ASCII letter or underscore, followed by word characters or underscores. Names such as `Alice`, `Plan_1`, and `DemoMedication` fit that pattern; `Alice Smith`, `Plan-1`, and a quoted name do not fit a single `ID`.

`INT` accepts one or more digits. Negative values and decimals are not part of this token. The source does **not** specify `returns number`; its exact definition is retained above. The lexical name `INT` should not be substituted for an explicit type declaration when extending downstream TypeScript code.

The grammar contains no comment terminal and no string-literal terminal. Do not assume that `// comments`, `/* comments */`, or quoted strings are supported in `.clinical` documents. Whitespace is ignored, but comments are not declared as hidden input.

Literal keywords use the spelling shown in the grammar. The semicolons ending grammar rules belong to the `.langium` specification; semicolons are not included as statement terminators in the `.clinical` language.

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

The only custom rule currently registered is `Patient: checkPatientStartsWithCapital`. It checks whether the first character differs from its uppercase form and reports:

```text
Patient name should start with a capital letter.
```

This is a **warning**, not an error. An initial underscore does not trigger that comparison, so the rule is not a strict requirement that every name begin with an uppercase alphabetic character.

The CLI filters diagnostics for severity `1` and exits when such errors exist. Its current document loader does not print or reject warnings. Therefore, a capitalization warning alone does not block generation.

No custom checks are implemented for age bounds, dose safety, medication–condition compatibility, controlled units, or duplicate declaration names. Syntactic validity and successful linking must not be interpreted as clinical correctness.

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
    │   │   ├── clinical-dsl-validator.ts Patient-name warning
    │   │   ├── index.ts                  Public exports
    │   │   └── generated/                Created by Langium generation
    │   └── test/                         Includes scaffold-era test content
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

`createClinicalDslServices(...)` combines Langium defaults, generated modules, and `ClinicalDslModule`; registers the language; and registers the patient-name check. Both the CLI and the language server use this service factory. The extension client communicates with its Node.js server using IPC. Sources: [services][services], [CLI entry][cli-main], [client][client], [server][server].

## 7. Build and run

### Requirements declared in the repository

The language and CLI package manifests declare Node.js `>=20.10.0` and npm `>=10.2.3`. The extension declares VS Code `^1.91.0`. Langium and `langium-cli` are specified as `~4.4.0`. These are the package declarations, not a guarantee that every resolved dependency accepts the minimum Node version; also check installation-time engine messages and the lockfile.

Sources: [language package][language-package], [CLI package][cli-package], and [extension manifest][extension-manifest].

### Prepare the workspace

From the repository root:

```bash
cd clinical-dsl-demo
npm install
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
node packages/cli/bin/cli.js generate packages/cli/src/demo.clinical -d generated
node generated/demo.js
```

The first command parses, links, and validates the document before writing `generated/demo.js`. The second command executes that generated JavaScript. Without `-d`, the generator writes the output beside the input file, with the same base name and a `.js` extension. It writes to that path directly, replacing existing contents if the file already exists.

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

### Tests require migration to the clinical grammar

The project exposes:

```bash
npm test
```

However, the active [`validating.test.ts`][validation-tests] still uses `person Langium` and `person langium`, and expects the old `Person` capitalization message. Those inputs do not match the current `patient ... { age ... condition ... }` grammar. The parsing and linking test files are named `parsing.test.ts.disabled` and `linking.test.ts.disabled`.

**Do not treat the existing test files as verified coverage of the clinical language.** They need clinical fixtures and expectations before the suite can serve that purpose. This README describes source behavior; it does not report a successful test run.

## 9. Current implementation boundaries

The following distinctions are important when extending the demo:

- **`show` is modeled but not used by the generator.** Generated output covers all plans, regardless of display statements.
- **Clinical data is represented, not clinically evaluated.** Conditions and units remain identifiers; there are no treatment-selection or prescription-safety rules.
- **Output generation is intentionally small.** It prints plan and patient names only. There is no natural-language interface, clinical database integration, or prescription execution in the inspected implementation.
- **Some scaffolding text remains outdated.** The CLI's help description still refers to greetings even though its generator now prints plan summaries, and the active validation tests still target the Hello World example.

The source files below are the authority for implementation behavior. The external Langium reference is used only to explain grammar notation, not to attribute additional application features to this project.

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
