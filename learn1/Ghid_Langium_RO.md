# Ghid practic Langium

DSL  EBNF  AST  Referințe  Validări  Comenzi

Acest ghid te ajută să construiești și să verifici un limbaj extern mic. Vei porni de la textul introdus în playground, vei urmări obiectele din AST și vei adăuga relații și reguli de validare. La final vei putea identifica locul unde trebuie implementat comportamentul aplicației.

Exemplele sunt verificate cu Langium și langium-cli 4.4.0. Data verificării este 16 septembrie 2026. Ghidul folosește date fictive pentru exerciții; MiniClinic este limbajul didactic din acest material.

| Noțiune | Rol |
| --- | --- |
| DSL | Limbaj specializat pentru date, reguli sau instrucțiuni dintr-un domeniu. |
| Gramatică | Definește sintaxa acceptată și, în Langium, contribuie la forma AST-ului. |
| EBNF | Notație pentru exprimarea regulilor de sintaxă. |
| Langium | Framework care construiește și procesează limbaje și servicii de editor. |
| AST | Obiectele ierarhice rezultate din parsarea unui document concret. |

## Ordinea de lucru

1. Citește paginile 2 și 3, apoi modifică primul exemplu în playground.

2. Lucrează cu referințele și validările de la paginile 4 și 5.

3. Pregătește proiectul și urmărește fișierele descrise la paginile 6 și 7.

4. Încearcă DSL-ul ML și pachetul executabil de la paginile 8 și 9.

5. Rezolvă exercițiile de la pagina 10. Sursele și cărțile sunt la paginile 11 și 12.

[Deschide playground-ul Langium](https://langium.org/playground/)


Pachetul de exemple conține trei gramatici complete, documente de intrare, un inspector al AST-ului și 11 verificări automate. Cheat sheet-ul separat are două pagini.

# De la caractere la structură

Un lexer recunoaște tokenuri, adică unități precum identificatori și numere. Parserul verifică succesiunea lor conform gramaticii. Pentru textul patient Ana age 42, tokenurile relevante sunt patient, Ana, age și 42. Regula Patient stabilește ordinea și capturează valorile.

## Terminale și expresii regulate

```
hidden terminal WS: /\s+/;
terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
terminal INT returns number: /[0-9]+/;
```

ID permite Ana, Ana42 și _patient1. Nu permite 42Ana, Ana-Maria sau diacritice în această versiune. INT recunoaște cifre și produce un număr; nu acceptă semn minus ori zecimale. WS permite spații și treceri la linie între tokenuri. Aceste alegeri aparțin limbajului construit.

## EBNF și notația Langium

```
Model = Patient, { Patient };
Patient = "patient", ID, "age", INT;
```

În această variantă EBNF, virgula exprimă succesiunea, acoladele repetarea și parantezele pătrate opționalitatea. ID și INT sunt presupuse definite lexical. Langium folosește o notație de tip EBNF și adaugă atribuiri pentru proprietățile AST-ului.

| EBNF clasic | Langium | Semnificație |
| --- | --- | --- |
| [ A ] | A? | Opțional |
| { A } | A* | Zero sau mai multe |
| A, { A } | A+ | Una sau mai multe |
| A \| B | A \| B | Alternativă |
| A, B | A B | Succesiune |

În Langium, [Patient:ID] este o referință, nu o expresie opțională. Și simbolul = depinde de context: în EBNF definește regula; în name=ID atribuie o valoare unei proprietăți.

Surse pentru aprofundare: R1, R3 și R8. Exemplele din această pagină sunt construite pentru ghid.

# Primul limbaj în playground

Înlocuiește tot conținutul din Grammar cu fișierul 01-patients.langium. În Content pune textul din 01-patients.clinic. Apasă pictograma de arbore din bara Content pentru a deschide Syntax tree.

```
grammar PatientList

entry Model:
    patients+=Patient+;

Patient:
    'patient' name=ID 'age' age=INT;

hidden terminal WS: /\s+/;
terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
terminal INT returns number: /[0-9]+/;
```

## Documentul de intrare

```
patient Ana age 42
patient Mihai age 35
```

## Structura rezultatului

```
{
  "$type": "Model",
  "patients": [
    { "$type": "Patient", "name": "Ana", "age": 42 },
    { "$type": "Patient", "name": "Mihai", "age": 35 }
  ]
}
```

patients+=Patient+ are două mecanisme: += adaugă rezultatele în listă; + cere cel puțin un pacient. name=ID stochează textul identificatorului; age=INT stochează numărul. Model și Patient sunt nume alese pentru reguli.

Ghilimelele din 'patient' aparțin gramaticii. În Content scrii patient. Punctul și virgula încheie regula din Grammar; pentru a-l cere și în Content trebuie inclus literalul ';' în regulă.

Încearcă age forty, apoi un document gol. Ambele produc probleme de sintaxă. age 999 este acceptat de această gramatică, deoarece nu există o limită semantică pentru vârstă. Vei adăuga una la pagina 5.

# Referințe liste și valori opționale

Înlocuiește integral Grammar și Content cu fișierele 02-relations.langium și 02-relations.clinic.

```
grammar MiniClinic

entry Model:
    (patients+=Patient | observations+=Observation)+;

Patient:
    'patient' name=ID 'age' age=INT
    ('symptom' symptoms+=ID)*;

Observation:
    'observe' patient=[Patient:ID]
    'severity' severity=('mild' | 'moderate' | 'severe')
    (urgent?='urgent')?;

hidden terminal WS: /\s+/;
terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
terminal INT returns number: /[0-9]+/;
```

```
patient Ana age 42 symptom fatigue symptom nausea
patient Mihai age 35

observe Ana severity moderate urgent
observe Mihai severity mild
```

symptoms+=ID acumulează identificatori. Repetarea * permite și absența simptomelor. severity acceptă doar mild, moderate sau severe. Grupul opțional urgent produce un boolean: true dacă este prezent, false dacă lipsește.

patient=[Patient:ID] creează o referință către un obiect Patient. Configurația implicită folosește numele declarației. observe Ana se leagă de pacientul Ana; în playground legătura poate apărea ca Reference('#/patients@0').

Înlocuiește Ana cu Maria doar în observație. Sintaxa rămâne recognoscibilă, dar referința nu se poate rezolva. Adaugă patient Maria age 30 și urmărește cum se rezolvă legătura. Într-un proiect mai mare, scope-ul controlează ce declarații sunt vizibile. [R4]

# Validări care verifică valorile

O regulă lexicală pentru întregi nu stabilește intervalul de valori permis. Pentru exercițiu alegem o politică a aplicației: vârsta nu poate depăși 130. Aceasta este doar o regulă didactică, nu o regulă medicală generală.

## O funcție de validare în TypeScript

```
import type { ValidationAcceptor } from 'langium';
import type { Patient } from './generated/ast.js';

export function checkPatientAge(
    patient: Patient,
    accept: ValidationAcceptor
): void {
    if (patient.age > 130) {
        accept('error', 'Varsta depaseste limita de 130.', {
            node: patient,
            property: 'age'
        });
    }
}
```

Importul Patient presupune că ai generat tipurile și că fișierul este lângă directorul generated. Înregistrează funcția în serviciile limbajului înainte de validarea documentelor. Variabila services trebuie să fie instanța serviciilor limbajului tău.

```
services.validation.ValidationRegistry.register({
    Patient: checkPatientAge
});
```

Pachetul atașat include aceeași logică executabilă în JavaScript, în validation.mjs, plus o verificare a numelor duplicate. Comanda cu --clinic-checks de la pagina 9 activează aceste funcții.

| Intrare | Verificare relevantă |
| --- | --- |
| age forty | Parserul așteaptă un întreg. |
| observe Maria ... | Linkerul caută un Patient numit Maria. |
| age 999 | Validatorul aplică limita definită de aplicație. |
| Două declarații patient Ana | Validatorul de unicitate verifică numele. |

Un AST poate exista și când documentul conține erori. Verifică diagnosticele înainte să folosești modelul pentru operații. Un input generat de un LLM poate fi verificat prin aceleași reguli. Rezultatul confirmă doar condițiile implementate de validatori. [R5]

# Proiect local și comenzi de lucru

Playground-ul este suficient pentru primele exerciții. Pentru fișiere, validări proprii și integrare într-o aplicație, folosește un proiect cu Node și npm. Alege o versiune Node LTS compatibilă cu toate dependențele proiectului.

```
node --version
npm --version
npm view langium engines
npm view langium-cli engines
```

Langium 4.4.0 declară Node >=20.10.0 și npm >=10.2.3, dar dependențele instalate cer o versiune Node mai nouă. Pentru pachetul atașat folosește Node >=22.12.0 și npm >=10.2.3. Într-un proiect existent, consultă package.json și fișierul lock înainte de actualizări.

## Crearea unui proiect nou

```
npm install -g yo generator-langium
yo langium
```

Poți alege numele mini-clinic, limbajul MiniClinic și extensia .clinic. Generatorul poate include o extensie VS Code, un CLI, suport web și teste. Opțiunile disponibile depind de versiunea generatorului. După generare intră în directorul creat. [R2]

```
cd mini-clinic
npm install
npm run
npm ls langium langium-cli
npm run langium:generate
npm run build
```

npm run listează scripturile reale. langium:generate și build sunt denumiri uzuale, nu comenzi universale garantate. Dacă ai creat proiectul cu alte opțiuni, folosește scripturile sale.

## CLI direct din proiect

```
npx langium generate --help
npx langium generate
npx langium generate --watch
npx langium generate --file langium-config.json
```

Aceste comenzi presupun că langium-cli este instalat în proiect. --file indică fișierul de configurare, nu documentul .clinic. --watch urmărește gramatica pentru regenerare. Oprești procesul watch cu Ctrl+C. F5 în VS Code poate porni extensia generată dacă proiectul include configurația de debug. [R2, R7]

# Fișierele și responsabilitățile lor

Separă definiția limbajului de documentele scrise în acel limbaj. Când modifici o regulă din gramatică se poate schimba forma tipurilor AST. Când modifici doar datele unui pacient se schimbă instanța AST a acelui document.

| Fișier sau componentă | Ce urmărești |
| --- | --- |
| *.langium | Regulile limbajului și atribuirea proprietăților AST. |
| *.clinic | Documente scrise în MiniClinic. Extensia este o alegere de configurare. |
| langium-config.json | Calea gramaticii, identificatorul limbajului și directorul generat. |
| package.json | Dependențe, scripturi npm și configurația proiectului. |
| generated/ast.ts | Definițiile TypeScript ale tipurilor AST, nu datele unui pacient. |
| Modulul limbajului | Creează și conectează serviciile, inclusiv validatorii proprii. |
| Validator | Verifică restricții definite de aplicație. |
| Generator sau interpretor | Transformă modelul sau implementează comportamentul lui. |

## Configurare minimă pentru exemplul atașat

```
{
  "projectName": "MiniClinic",
  "languages": [{
    "id": "mini-clinic",
    "grammar": "02-relations.langium",
    "fileExtensions": [".clinic"]
  }],
  "out": "generated"
}
```

Căile sunt cele din pachetul atașat. Un proiect creat cu Yeoman poate folosi src/language și alt director generated. Modifică sursa gramaticii și regenerează; editările manuale din fișierele generate pot fi suprascrise.

Fluxul conceptual este: text, tokenuri, AST, rezolvarea referințelor, validări, apoi logica aplicației. Langium gestionează și etape de indexare și calcul al scope-urilor între acestea. [R6]

# Un DSL pentru descrierea unui pipeline ML

Acest exemplu arată cum poți descrie un dataset, un model și o cerere de antrenare. Copiază în playground fișierele 03-pipeline.langium și 03-pipeline.pipeline.

```
grammar MiniPipeline

entry Model:
    (datasets+=Dataset | models+=MLModel | runs+=Training)+;

Dataset:
    'dataset' name=ID 'from' path=STRING;

MLModel:
    'model' name=ID 'type' kind=('classifier' | 'regressor');

Training:
    'train' model=[MLModel:ID]
    'on' dataset=[Dataset:ID] 'epochs' epochs=INT;

hidden terminal WS: /\s+/;
terminal STRING: /"([^"\\]|\\.)*"/;
terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
terminal INT returns number: /[0-9]+/;
```

```
dataset images from "frames.csv"
model baseline type classifier
train baseline on images epochs 5
```

AST-ul conține un Dataset cu path egal cu frames.csv, un MLModel de tip classifier și un Training cu epochs egal cu 5. Proprietățile model și dataset din Training sunt referințe către declarațiile respective.

Acest parser nu deschide frames.csv și nu antrenează un model. Pentru a efectua antrenarea, codul aplicației trebuie să prelucreze nodul Training, să verifice condițiile relevante și să apeleze biblioteca ML. Poți și să generezi un fișier Python, dar generatorul de Python trebuie implementat separat.

npx langium generate generează infrastructura limbajului. Nu înseamnă că rulează instrucțiunea train din document. Separă întotdeauna generarea infrastructurii de executarea sau traducerea documentelor DSL. [R9]

# Rulează pachetul de exemple

Dezarhivează Langium_Exemple_RO.zip și deschide un terminal în directorul langium-exemple. Folosește Node >=22.12.0 și npm >=10.2.3. Langium și langium-cli sunt fixate la 4.4.0. Pachetul este un laborator de parsare și validare și poate fi folosit fără VS Code.

```
npm install
npm test
npm run generate
```

npm test rulează 11 verificări. npm run generate produce infrastructura pentru 02-relations.langium în directorul generated, conform langium-config.json. Inspectorul de mai jos construiește serviciile din gramatica citită și nu depinde de fișierele generate.

## Inspectarea unui document valid

```
npm run inspect -- 01-patients.langium 01-patients.clinic
npm run inspect -- 02-relations.langium 02-relations.clinic
npm run inspect -- 03-pipeline.langium 03-pipeline.pipeline
```

Ieșirea afișează numărul erorilor lexicale și de parsare, diagnosticele și AST-ul serializat. Referințele serializate pot avea o formă diferită de afișarea din playground, păstrând aceeași semnificație.

## Compararea aceleiași intrări cu și fără validare proprie

```
npm run inspect -- 02-relations.langium invalid-age.clinic
npm run inspect -- 02-relations.langium invalid-age.clinic --clinic-checks
```

Prima comandă acceptă 999 deoarece gramatica cere un întreg. A doua activează politica didactică și raportează eroarea. Codul de ieșire 1 este intenționat când documentul are erori.

## O referință care nu se poate rezolva

```
npm run inspect -- 02-relations.langium invalid-reference.clinic
```

Maria nu este declarată. Verificarea ilustrează diferența dintre recunoașterea unui identificator și rezolvarea legăturii sale. inspect.mjs folosește helper-ele createServicesForGrammar și parseHelper pentru laborator; într-o aplicație poți folosi serviciile și tipurile generate. [R4, R5]

# Exerciții și depanare

## Exerciții cu rezultat verificabil

1. Fă vârsta opțională în primul exemplu. Soluție: înlocuiește partea obligatorie cu ('age' age=INT)?. Încearcă patient Ana și patient Mihai age 35.

2. Permite un document gol. Soluție: schimbă patients+=Patient+ în patients+=Patient*. Compară diagnosticele pentru Content gol.

3. Cere cel puțin un simptom. Soluție: în regula Patient din exemplul 2 schimbă * de după grupul symptom în +. Pacientul Mihai va necesita un simptom.

4. Adaugă critical ca nivel de severitate. Soluție: adaugă alternativa 'critical' în grupul severity. Adăugarea cuvântului nu implementează o acțiune a aplicației.

5. Scrie de două ori patient Ana. Rulează inspectorul cu --clinic-checks. Validatorul de unicitate trebuie să raporteze numele duplicat.

6. Schimbă dataset-ul din comanda train în unknown. Sintaxa rămâne recognoscibilă, dar referința nu se rezolvă. Definește dataset unknown from "other.csv" și verifică din nou.

## Cum localizezi problema

| Simptom | Prima verificare utilă |
| --- | --- |
| Grammar conține erori | Reguli complete, terminale definite, nume și punctuație. |
| Content așteaptă alt token | Ordinea, cuvintele literale, tipul valorii și cardinalitățile. |
| Could not resolve reference | Numele exact, tipul țintei și scope-ul disponibil. |
| Validatorul nu raportează | Funcția este înregistrată și validarea documentului este activată. |
| npm run nu găsește scriptul | Listează scripturile reale prin npm run. |
| Editorul folosește forma veche | Regenerează, reconstruiește și repornește extensia dacă este necesar. |

Gramatica nu furnizează singură un vocabular de domeniu validat, instrucțiuni pentru utilizator sau un motor de raționament. Pentru un DSL clinic utilizabil, documentează sintaxa și oferă exemple, șabloane și completare în editor. Restricțiile de domeniu trebuie modelate explicit.

# Documentație oficială și ordine de lectură

Pentru sintaxa și API-urile Langium, folosește documentația oficială și versiunea pachetelor din proiect. Cărțile de la pagina următoare explică principiile de proiectare a limbajelor.

[R1 Grammar Language](https://langium.org/docs/reference/grammar-language/)
Referința pentru reguli, terminale, atribuiri și referințe. Consult-o când întâlnești o construcție pe care nu o recunoști.

[R2 Langium workflow](https://langium.org/docs/learn/workflow/)
Parcurge pașii pentru creare, gramatică, generare, referințe și validări. Verifică cerințele Node din pachetele curente.

[R3 MiniLogo tutorial](https://langium.org/docs/learn/minilogo/)
Tutorial progresiv: gramatică, validări, CLI, generator, extensie și integrare web. Este următorul exercițiu după MiniClinic.

[R4 Resolve cross references](https://langium.org/docs/learn/workflow/resolve_cross_references/)
Explică legătura dintre identificatori, obiectele țintă și rezolvarea referințelor.

[R5 Create validations](https://langium.org/docs/learn/workflow/create_validations/)
Arată cum se scriu, înregistrează și verifică validările proprii.

[R6 Document Lifecycle](https://langium.org/docs/reference/document-lifecycle/)
Pentru a înțelege ordinea parsării, indexării, scope-urilor, linking-ului și validării.

[R7 Langium CLI](https://www.npmjs.com/package/langium-cli)
Pachetul oficial și referința comenzilor. În proiect, --help este reperul pentru opțiunile versiunii instalate.

[R9 Generate artifacts](https://langium.org/docs/learn/workflow/generate_everything/)
Explică prelucrarea modelului și generarea artefactelor propriei aplicații.

Parcurs sugerat: workflow și MiniLogo pentru lucru practic; Grammar Language ca referință; lifecycle și API-urile instalate când implementezi integrări sau investighezi erori.

# Cărți și documente pentru aprofundare

[R8 ISO IEC 14977 Extended BNF](https://www.cl.cam.ac.uk/~mgk25/iso-14977.pdf)
PDF al specificației EBNF. Consultă definițiile pentru secvențe opționale, repetate și grupate. Este o referință formală, utilă după exemplele practice.

[R10 A Langium based approach to BigER](https://model-engineering.info/publications/theses/thesis-jordan-zib.pdf)
Tobias Jordan și Sebastian Zib, TU Wien, 2024. Lucrare de licență cu 64 de pagini PDF. Începe cu secțiunea 2.3 Langium, apoi 4.1 Grammar, 4.2 Code Generation și 4.3 Validation. Codul reflectă versiunea folosită în 2024.

[R11 Domain Specific Languages](https://martinfowler.com/books/dsl.html)
Martin Fowler, cu Rebecca Parsons, 2010. Carte despre alegerea și implementarea DSL-urilor interne și externe, modelul semantic și generarea de cod. Este o carte comercială; pagina autorului indică opțiunile electronice și un capitol introductiv gratuit.

[Capitolul introductiv gratuit al cărții lui Fowler](https://www.informit.com/articles/article.aspx?p=1592379)
Un exemplu gradual care leagă sintaxa de modelul pe care îl descrie.

[R12 Language Implementation Patterns](https://pragprog.com/titles/tpdsl/language-implementation-patterns/)
Terence Parr, 2009. Carte comercială despre parsare, arbori, simboluri, interpretare și generare. Exemplele folosesc Java și uneori ANTLR; conceptele pot fi aplicate când lucrezi cu Langium.

[Extras PDF gratuit despre arbori](https://media.pragprog.com/titles/tpdsl/patterns.pdf)
Extras de 9 pagini oferit de editură, din partea despre reprezentări intermediare sub formă de arbori. Nu este cartea completă.

Alege Fowler pentru proiectarea unui DSL și colaborarea dintre sintaxă și modelul de domeniu. Alege Parr pentru a aprofunda ce se întâmplă în spatele parserului. Pentru API-uri și comenzi Langium continuă să folosești documentația oficială.

Toate exemplele din pachet sunt editabile. Încearcă modificări mici, inspectează AST-ul și verifică diagnosticele după fiecare schimbare.
