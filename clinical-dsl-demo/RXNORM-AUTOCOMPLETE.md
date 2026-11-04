# RxNorm product autocomplete

The editor can search the locally imported RxNorm release while a Medication declaration is incomplete. The suggestion label shows the complete product name; its details identify the RxCUI and type. Choosing a suggestion with **Tab** writes the product identity into the document, so it survives saving, reopening, and AST export.

Search returns **SCD** (semantic clinical drug) and **SBD** (semantic branded drug) products. A bare ingredient match such as `aspirin` is not treated as a selected product.

## Start the local search service

Use the companion `scala-testing-lab` version containing `serve-products` and explicit product bindings, and the same PostgreSQL configuration used for resolution. In that repository, run once per editor session:

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

1. Type `medication aspi`. After at least two characters, the editor waits briefly and queries matching imported product names and synonyms.
2. Inspect the product name and RxCUI in the suggestion list. Use the arrow keys to select the intended product, then **Tab** to accept it. **Ctrl+Space** opens suggestions manually.
3. Completion inserts the `rxcui` and `rxnormRelease` fields together. For a new declaration it creates a readable identifier; selecting a product for an existing colon declaration preserves its alias and existing Plan references.
4. Enter the administered `dose`, `route`, and `frequency`. Existing fields and comments are retained. Existing `strength` and `doseForm` are not silently overwritten.
5. Save and run terminology resolution. Preview JSON contains the stored `productBinding` and, after successful validation, Scala's `selectedProduct`.

To select or change a product while keeping an arbitrary alias such as `MorningMedication`, type a search prefix inside the RxCUI quotes, for example `rxcui "aspi"`, then choose a product with Tab. Completion replaces the search text with its numeric RxCUI and updates the release together. Until a product is chosen, the nonnumeric search text is an incomplete binding and cannot be exported. The editor's automatic closing quotes keep the value ready for suggestions; Ctrl+Space also works.

The following is a **synthetic syntax example**. `900001` is a fixture identifier, not a verified real product to select:

```text
Patient DemoPatient: age 30, condition DemoCondition
Medication DemoProduct: rxcui "900001" rxnormRelease "2026-10-05" dose 10mg route PO frequency BID
Plan DemoPlan: prescribe DemoProduct for DemoPatient
show DemoPlan
```

The binding can appear anywhere among the colon fields and its keywords accept mixed case. Both values are quoted strings; the RxCUI is never converted to a floating-point number. Press **?** for a concrete example when a binding field is missing.

Tab uses VS Code's normal acceptance of the selected suggestion. It is not globally rebound, and automatic completion does not mean that a clinician has confirmed a prescription. Without a visible suggestion list, Tab retains the user's editor behavior.

## Identity and validation

| Situation | Result |
| --- | --- |
| Save, close, and reopen | The same RxCUI and release remain in the DSL text. |
| Rename the local alias | The binding is unchanged; update Plan references as for any declaration rename. |
| Change the configured release | The saved binding is not silently migrated. Choose a product from the new release before resolution. |
| RxCUI absent from the imported release | Resolution reports that the selected product was not found. It does not fall back to the alias. |
| RxCUI identifies an ingredient or another unsupported type | Resolution rejects it as an explicit product. |
| Existing strength/form conflict with the selected product | Validation returns a conflict or clarification result, rather than selecting another product. |
| Search is unavailable or times out | Grammar completion and local parsing remain available. No product is invented or inserted. |

Explicit binding can identify a combination product. If manual strength/form qualifiers are also supplied, the existing conservative single-component qualifier policy still applies. Product identity is distinct from administered dose, route suitability, treatment appropriateness, and clinician confirmation.

## Data flow and contract

Typing updates Langium locally. Product completion separately sends only the prefix, release, and result limit to the local service. A 200 ms debounce, bounded expiring cache, request timeout, cancellation, and document-version checks prevent older search results from replacing newer text. These are implementation settings, not a measured latency guarantee.

The search response is a candidate list. Acceptance writes a binding into the user's source; it does not run the final resolver. Existing save/manual resolution uses the current document and verifies that the returned selected product has exactly the stored ID and release.

```json
{
  "productBinding": {
    "rxcui": "900001",
    "release": "2026-10-05"
  }
}
```

This optional object appears in the medication preview and each corresponding exported mention. Requests with at least one binding use `schemaVersion: "2"` and `policyVersion: "explicit-product-v1"`. Documents without bindings keep `schemaVersion: "1"` and `policyVersion: "exact-v1"`. The Scala report remains schema `2` and echoes the binding with the mention. Both repository changes are required for bound documents.

The product label is display text. `Medication.name` remains a DSL identifier and is the target of `Plan.prescribe`; it is not replaced by an entire multiword RxNorm label. Patient syntax and the existing named Plan relationships are unchanged.
