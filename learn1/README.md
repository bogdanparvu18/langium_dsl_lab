# Langium Examples

This repository contains a set of small Langium examples designed to demonstrate grammar definitions, AST generation, cross-references, semantic validation, and a simple machine learning pipeline DSL.

The examples were verified using:

* **Langium:** 4.4.0
* **langium-cli:** 4.4.0
* **Verification date:** September 16, 2026

## Running the Examples in the Langium Playground

Open the official Langium Playground:

https://langium.org/playground/

Replace the contents of both editors with the corresponding grammar and example input files.

| Grammar                | Example Input          |
| ---------------------- | ---------------------- |
| `01-patients.langium`  | `01-patients.clinic`   |
| `02-relations.langium` | `02-relations.clinic`  |
| `03-pipeline.langium`  | `03-pipeline.pipeline` |

After loading an example, click the **tree icon** next to the **Content** editor to inspect the generated AST.

The file `Ghid_Langium_RO.md` contains a more detailed Langium guide in editable Markdown format.

## Running the Examples Locally

### Requirements

Use:

* **Node.js >= 22.12.0**
* **npm >= 10.2.3**

Langium 4.4.0 itself supports an older minimum Node.js version, but some dependencies used by this project require the newer version.

From the directory containing this README, install the dependencies:

```bash
npm install
```

Run the test suite:

```bash
npm test
```

Generate the Langium infrastructure:

```bash
npm run generate
```

You can then inspect each grammar and its corresponding input file:

```bash
npm run inspect -- 01-patients.langium 01-patients.clinic
npm run inspect -- 02-relations.langium 02-relations.clinic
npm run inspect -- 03-pipeline.langium 03-pipeline.pipeline
```

## Generated Langium Infrastructure

Running:

```bash
npm run generate
```

generates the Langium infrastructure for the **MiniClinic** grammar inside the `generated` directory.

These generated files typically contain language metadata, AST-related definitions, and service configuration required by a full Langium application.

The inspector included in this repository is intended as a lightweight learning environment. It uses Langium's dynamic helper APIs and therefore does not require the generated files to be compiled before running the examples.

A production Langium project would normally use the generated services together with the generated TypeScript AST types.

## Semantic Validation Examples

The examples also demonstrate the difference between syntax validation and custom semantic validation.

Run:

```bash
npm run inspect -- 02-relations.langium invalid-age.clinic
```

This input is syntactically valid, so an age value such as `999` can still be accepted by the grammar.

To enable the custom clinical validation rules defined in `validation.mjs`, run:

```bash
npm run inspect -- 02-relations.langium invalid-age.clinic --clinic-checks
```

The same input is now rejected because the custom validator considers the age invalid.

You can also test unresolved cross-references:

```bash
npm run inspect -- 02-relations.langium invalid-reference.clinic
```

This example contains a reference to `Maria` without a corresponding declaration, allowing Langium's reference resolution behavior to be observed.

An exit code of `1` for invalid input is intentional.

## About the Examples

The clinical rules and patient data used in these examples are entirely fictional and are provided only for educational purposes.

The maximum age of `130`, for example, is not a medical rule. It is simply an example of a custom semantic validation policy.

The machine learning DSL example is also intentionally simplified.

It describes the structure of an ML pipeline, but it does **not**:

* read CSV files,
* preprocess a real dataset,
* train machine learning models,
* execute model inference.

No dataset is required to run the included examples or tests.

## Tests

Run the complete test suite with:

```bash
npm test
```

The current test suite verifies **11 behaviors**, including:

* AST construction,
* grammar cardinality,
* cross-reference resolution,
* Boolean values,
* semantic validation,
* invalid references,
* invalid clinical values,
* ML pipeline parsing.

These tests are intended both as automated verification and as practical examples of how Langium processes DSL input.

## References

Official Langium documentation:

* https://langium.org/docs/reference/grammar-language/
* https://langium.org/docs/learn/workflow/
* https://langium.org/docs/learn/minilogo/

Langium CLI:

* https://www.npmjs.com/package/langium-cli
