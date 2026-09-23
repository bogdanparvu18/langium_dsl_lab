# Medication DSL: A Langium Example Generated with Yeoman

This project was created with generator-langium 4.4.0 (Yeoman). The medication names and doses in examples/ are fictional and serve only to demonstrate the parser. The grammar checks syntax; it does not assess the safety of a prescription.

## 1. Create the Same Project Structure with Yeoman

Run the following commands in a terminal:

~~~bash
npm install -g yo generator-langium
yo langium
~~~

Answer the generator prompts as follows:

| Prompt | Answer |
| --- | --- |
| Your extension name | medication-lab |
| Your language name | Medication |
| File extensions | .med |
| Your grammar entry rule name | Model |
| Include VSCode extension? | Yes |
| Generate example project? | No (minimal project) |
| Include CLI? | No |
| Include language tests? | No |

Yeoman creates the packages/language and packages/extension directories and configures langium-config.json. If you use the project in this archive, the structure is already in place; do not run yo langium inside it.

## 2. Write the Grammar and the DSL Input

- packages/language/src/medication.langium defines **the language rules**. It replaces the sample Element rule produced by Yeoman.
- examples/valid.med is **a document written in the Medication DSL**. It is neither TypeScript code nor a grammar file.
- examples/invalid.med contains an input rejected by the parser because XYZ is not an allowed route.
- packages/language/src/generated/ is created by langium generate. Do not edit these generated files manually.
- packages/language/src/medication-module.ts and medication-validator.ts are editable files created by Yeoman. The module connects the language services, while the validator can hold additional semantic checks. This example does not add custom validation rules.

Each medication order has this format:

~~~text
medication NAME dose NUMBER UNIT [FORM] via ROUTE every FREQUENCY;
~~~

For example:

~~~text
medication DemoMedA dose 10 mg tablet via PO every BID;
medication DemoMedB dose 2.5 ml liquid via PO every Q6H;
~~~

The name=ID rule accepts a single identifier without spaces or hyphens. NUMBER is converted to a numeric value. FORM is optional. Q6H matches the Q_HOURS terminal rule, which is declared before ID because both terminal patterns could match Q6H.

## 3. Generate the Parser and Inspect the AST

From the medication-lab project root, run:

~~~bash
npm install
npm run langium:generate
npm run build
node scripts/show-ast.mjs examples/valid.med
~~~

The inspection command prints a simplified JSON view of the AST. It shows a Model root with three MedicationOrder nodes in orders. Each order contains a Dosage node, while route and frequency are simple string values.

To see a syntax error, run:

~~~bash
node scripts/show-ast.mjs examples/invalid.med
~~~

After changing the grammar, run npm run langium:generate and npm run build again. If you change only the text in a .med file, you do not need to regenerate the grammar.

## 4. Understand the Resulting Structure

Input: medication DemoMedA dose 10 mg tablet via PO every BID;

~~~json
{
  "$type": "Model",
  "orders": [
    {
      "$type": "MedicationOrder",
      "name": "DemoMedA",
      "dosage": {
        "$type": "Dosage",
        "value": 10,
        "unit": "mg",
        "form": "tablet"
      },
      "route": "PO",
      "frequency": "BID"
    }
  ]
}
~~~

MedicationOrder and Dosage are AST nodes. PO and BID are string values stored on the MedicationOrder node. Their generated TypeScript interfaces appear in packages/language/src/generated/ast.ts; they are not JavaScript classes instantiated with new.

## 5. View Diagnostics in VS Code

Open the project root in VS Code desktop, run npm run langium:generate and npm run build, then start the **Run Extension** configuration with F5. In the new window, open examples/valid.med or examples/invalid.med. The language server recognizes the .med extension and shows syntax errors. The terminal-based AST inspection works independently of the VS Code extension.

Official documentation: https://langium.org/docs/learn/workflow/scaffold/ and https://langium.org/docs/reference/grammar-language/.
