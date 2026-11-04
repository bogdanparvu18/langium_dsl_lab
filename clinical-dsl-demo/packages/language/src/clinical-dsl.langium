grammar ClinicalDSLDemo

entry Model:
    (
        patient+=Patient |
        medication+=Medication |
        plan+=Plan |
        display+=DisplayPlan 
    )*;

Patient:
    ('patient' | 'Patient') name=Identifier
    ('{' 'age' age=INT 'condition' condition=Identifier '}'
    | ':' 'age' age=INT ',' 'condition' condition=Identifier);

Medication:
    'medication' name=Identifier
    ('{'
        amount=DoseAmount unit=Unit
        ('strength' productStrength=STRING)?
        ('doseForm' doseForm=STRING)?
        'route' route=Route 'frequency' frequency=Frequency
    '}'
    | ':' (
        ('dose'? amount=DoseAmount unit=Unit |
         'strength' productStrength=ProductStrength |
         'doseForm' doseForm=ProductForm |
         'rxcui' rxcui=STRING | 'rxnormRelease' rxnormRelease=STRING |
         'route' route=Route | 'frequency' frequency=Frequency) ','?
    )*);

UnquotedStrength returns string:
    (DECIMAL | INT) ('mg' | 'mcg' | 'g')
    ('/' (DECIMAL | INT)? 'ml')?;

ProductStrength returns string:
    STRING | UnquotedStrength;

ProductForm returns string:
    STRING | UnquotedForm;

// A word pair keeps "Metered Dose Inhaler" readable without consuming the
// dose field in "doseForm Oral Tablet dose 10mg". Other reserved words or
// forms ending in Dose can be quoted to make the value boundary explicit.
UnquotedForm returns string:
    (ID | ('dose' ID))+;

// Keywords are reserved by the lexer globally. In a name/reference position
// they are ordinary identifiers, preserving names such as Patient Po or Dose.
Identifier returns string:
    ID | 'patient' | 'Patient' | 'age' | 'condition' |
    'medication' | 'plan' | 'show' | 'for' | 'prescribe' |
    'dose' | 'strength' | 'doseForm' | 'route' | 'frequency' | 'rxcui' | 'rxnormRelease' |
    Unit | Route | Frequency;

Plan:
    'plan' name=Identifier
    ('{' 'for' patient=[Patient:Identifier] 'prescribe' medication=[Medication:Identifier] '}'
    | ':' (('for' patient=[Patient:Identifier] ','?) & ('prescribe' medication=[Medication:Identifier] ','?)));

DisplayPlan:
    'show' plan=[Plan:Identifier];

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
