grammar Medication

// Un fisier .med contine zero sau mai multe comenzi.
entry Model:
    (orders+=MedicationOrder)*;

// Fiecare comanda devine un nod MedicationOrder in Model.orders.
MedicationOrder:
    'medication' name=ID
    'dose' dosage=Dosage
    'via' route=Route
    'every' frequency=Frequency
    ';';

// Dosage devine un nod separat, deoarece are mai multe proprietati.
Dosage:
    value=NUMBER unit=Unit (form=Form)?;

// Aceste reguli returneaza valori string, fara noduri AST separate.
Route returns string:
    'PO' | 'IV' | 'IM' | 'SC' | 'PR' | 'SL' | 'BUCC';

Frequency returns string:
    'QD' | 'BID' | 'TID' | 'QID' | 'PRN' | Q_HOURS;

Form returns string:
    'tablet' | 'capsule' | 'liquid' | 'injection' | 'spray';

Unit returns string:
    'mg' | 'mcg' | 'g' | 'ml' | 'puff' | 'unit';

// Q_HOURS trebuie declarat inainte de ID: Q6H corespunde ambelor regexuri.
terminal Q_HOURS: /Q[0-9]+H/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]+)?/;
terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;

hidden terminal WS: /\s+/;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
