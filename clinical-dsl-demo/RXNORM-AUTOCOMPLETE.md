# RxNorm product autocomplete

The editor can search the locally imported RxNorm release while a Medication declaration is incomplete. The suggestion label shows the complete product name; its details identify the RxCUI and type. Choosing a suggestion with **Tab** writes the complete product name and its RxCUI into the document, so it survives saving, reopening, and AST export.

Search returns **SCD** (semantic clinical drug) and **SBD** (semantic branded drug) products. A bare ingredient match such as `aspirin` is not treated as a selected product.

## Start the local search service

Use the companion `scala-testing-lab` version that supports `serve-products` and the `display` field in explicit bindings, and the same PostgreSQL configuration used for resolution. In that repository, run once per editor session:

```sh
sbt "run serve-products 8765"
```

If sbt is not on PATH, use the Java/sbt launcher installed by the Scala README:

```sh
java -Dsbt.supershell=false -Dsbt.log.noformat=true -jar /path/to/sbt-launch.jar "run serve-products 8765"
```

The process stays running until stopped. It listens only on `127.0.0.1` and searches local PostgreSQL. It does not download RxNorm data or start a new JVM for each prefix. The imported release must be ready before search can succeed. Startup creates the prefix index if missing; initial index creation can take longer than subsequent starts.

Configure VS Code:

```json
{
  "clinicalDsl.rxnorm.searchEnabled": true,
  "clinicalDsl.rxnorm.searchUrl": "http://127.0.0.1:8765",
  "clinicalDsl.rxnorm.release": "2026-10-05"
}
```

Use a release that is actually imported in your database. The existing Scala path, tool paths, database settings, and PostgreSQL password are still required for the separate **Resolve Medications with RxNorm** command. The search server uses its own process environment for PostgreSQL credentials; VS Code SecretStorage is not automatically exported to the terminal.

After updating the Langium checkout:

```sh
npm ci
npm run langium:generate
npm run build
```

Reload the extension development host to use the new bundle.

## Select and preserve a product

Type a product prefix where you want a medication declaration. Two characters start the search. Choose the intended product in the list and press **Tab**. **Ctrl+Space** opens the list manually. The search works with prefixes of other product names and imported synonyms too.

These three inputs show where to type. The examples use a synthetic catalog that returns `aspirin synthetic product` with RxCUI `900001`.

| What you type | What appears after you accept the product |
| --- | --- |
| `aspi` on a new declaration line | `Medication aspirin: product "aspirin synthetic product" rxcui "900001"` |
| `Medication aspi` | `Medication aspirin: product "aspirin synthetic product" rxcui "900001"` |
| `Medication MorningMedication: aspi` | `Medication MorningMedication: product "aspirin synthetic product" rxcui "900001"` |

A new medication gets a readable alias, made unique if needed. To change the product for an existing alias, type a prefix before its existing fields, for example `Medication MorningMedication: aspi product "Old label" rxcui "900002"`. With the cursor after `aspi`, choose the new product and press Tab. The editor replaces the previous name and RxCUI together and preserves Plan references.

The bare shortcut takes a single word. For a longer phrase with spaces or punctuation, type inside a quoted product value, for example `product "aspirin 81"`. Typing inside `rxcui "aspi"` also works.

Enter the administered `dose`, `route`, and `frequency`, then save and run terminology resolution. Existing fields and comments are retained. An unaccepted search prefix is temporary editing text. Only a selected product supplies an exact RxCUI binding.

A complete plan using the same synthetic product looks like this:

```text
Patient DemoPatient: age 30, condition DemoCondition
Medication MorningMedication: product "aspirin synthetic product" rxcui "900001" dose 10mg route PO frequency BID
Plan DemoPlan: prescribe MorningMedication for DemoPatient
show DemoPlan
```

The binding can appear anywhere among the colon fields and its keywords accept mixed case. Both values are quoted strings; the RxCUI is never converted to a floating-point number. Press **?** for a concrete example when a binding field is missing.

Tab uses VS Code's normal acceptance of the selected suggestion. It is not globally rebound, and automatic completion does not mean that a clinician has confirmed a prescription. Without a visible suggestion list, Tab retains the user's editor behavior.

## Health Canada monographs

Start `serve-products` from the installed Scala checkout after bootstrap has populated the Health Canada Drug Product Database (DPD). Typing a prefix searches RxNorm locally. Accepting a product asks the same Scala service for Canadian candidates matching the selected RxCUI and release. The picker shows the brand, DIN, ingredients, forms and routes so you can confirm the presentation. Press Escape to keep the RxNorm selection and continue without opening a monograph.

After confirmation, Scala obtains the English PDF linked by Health Canada and keeps the document in the installed Scala repository. The notification offers **Open dosage section** if the service located the relevant PDF page, or **Open PDF** otherwise. The document opens in your browser. Dose, route and frequency remain editable by the clinician.

To reopen the PDF, put the cursor in the Medication declaration and run **Clinical DSL: Open Health Canada Product Monograph** from the Command Palette. For saved documents, the extension remembers the confirmed DIN for that declaration, RxNorm product and release in the current VS Code workspace. If multiple presentations are available, the command also lets you change the DIN. PDF reuse works offline from Health Canada while the local Scala service and databases are running. When a Canadian match or electronic monograph is unavailable, the editor reports this and keeps the DSL text.

## Identity and validation

| Situation | Result |
| --- | --- |
| Save, close, and reopen | The full product name and RxCUI remain visible in the DSL. |
| Rename the local alias | The binding is unchanged; update Plan references as for any declaration rename. |
| Change the configured release | Resolution checks the saved RxCUI and exact product label in the configured release. If a label changes, choose the product again to accept its current name. |
| RxCUI absent from the imported release | Resolution reports that the selected product was not found. It does not fall back to the alias. |
| RxCUI identifies an ingredient or another unsupported type | Resolution rejects it as an explicit product. |
| Existing strength/form conflict with the selected product | Validation returns a conflict or clarification result, rather than selecting another product. |
| Search is unavailable or times out | Grammar completion and local parsing remain available. No product is invented or inserted. |

Explicit binding can identify a combination product. If manual strength/form qualifiers are also supplied, the existing conservative single-component qualifier policy still applies. Product identity is distinct from administered dose, route suitability, treatment appropriateness, and clinician confirmation.

## Data flow and contract

Typing updates Langium locally. Product completion separately sends only the prefix, release, and result limit to the local service. A 200 ms debounce, bounded expiring cache, request timeout, cancellation, and document-version checks prevent older search results from replacing newer text. These are implementation settings, not a measured latency guarantee.

The search response is a candidate list. Acceptance writes a binding into the user's source; it does not run the final resolver. Existing save/manual resolution uses the current document and verifies that the returned product matches the ID, saved display name and configured release. Older files containing `rxnormRelease` retain their original release check until the user selects a product again.

```json
{
  "productBinding": {
    "rxcui": "900001",
    "display": "aspirin synthetic product",
    "release": "2026-10-05"
  }
}
```

The example shows the exported mention. The source preview shows the RxCUI and display name as written. Export supplies the configured release and the report records the release used for verification. Requests with at least one binding use `schemaVersion: "2"` and `policyVersion: "explicit-product-v1"`. Documents without bindings keep `schemaVersion: "1"` and `policyVersion: "exact-v1"`. The Scala report remains schema `2` and echoes the binding with the mention. Both repository changes are required for bound documents.

The `product` field holds the full display text. `Medication.name` supplies the identifier referenced by `Plan.prescribe`. Patient syntax and the existing named Plan relationships are unchanged.
