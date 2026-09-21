# Exemple Langium în română

Versiuni verificate: langium 4.4.0 și langium-cli 4.4.0, la 16 septembrie 2026.

## În playground

Deschide https://langium.org/playground/ și înlocuiește integral cele două editoare.

| Grammar | Content |
| --- | --- |
| 01-patients.langium | 01-patients.clinic |
| 02-relations.langium | 02-relations.clinic |
| 03-pipeline.langium | 03-pipeline.pipeline |

Apasă pictograma de arbore de lângă Content pentru a vedea AST-ul.
Ghid_Langium_RO.md conține ghidul în format text editabil.

## În terminal

Folosește Node >=22.12.0 și npm >=10.2.3. Langium 4.4.0 declară un minim
Node mai vechi, dar dependențele din acest pachet cer versiunea mai nouă.
În directorul acestui README:

```bash
npm install
npm test
npm run generate
npm run inspect -- 01-patients.langium 01-patients.clinic
npm run inspect -- 02-relations.langium 02-relations.clinic
npm run inspect -- 03-pipeline.langium 03-pipeline.pipeline
```

`npm run generate` produce infrastructura pentru gramatica MiniClinic în
`generated`. Inspectorul este un laborator bazat pe helper-ele dinamice Langium;
el nu necesită compilarea acestor fișiere generate. Un proiect de producție poate
folosi serviciile generate și tipurile AST TypeScript.

## Verificarea regulilor proprii

```bash
npm run inspect -- 02-relations.langium invalid-age.clinic
npm run inspect -- 02-relations.langium invalid-age.clinic --clinic-checks
npm run inspect -- 02-relations.langium invalid-reference.clinic
```

Prima comandă acceptă sintactic vârsta 999. A doua activează validarea didactică
din validation.mjs și o respinge. A treia găsește o referință către Maria fără
declarație. Codul de ieșire 1 la o intrare invalidă este intenționat.

Regulile clinice și datele sunt fictive pentru exercițiu. Limita de vârstă 130
este o politică didactică. DSL-ul ML doar descrie pipeline-ul; nu citește CSV și
nu antrenează modele. Nu este necesar un dataset pentru testele incluse.

`npm test` verifică 11 comportamente, inclusiv AST, cardinalitate, referințe,
booleeni, validare semantică și exemplul de pipeline.

## Referințe

- https://langium.org/docs/reference/grammar-language/
- https://langium.org/docs/learn/workflow/
- https://langium.org/docs/learn/minilogo/
- https://www.npmjs.com/package/langium-cli
