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
        amount=DoseAmount unit=Unit
        'route' route=Route
        'frequency' frequency=Frequency
    '}';

Plan:
    'plan' name=ID '{'
        'for' patient=[Patient]
        'prescribe' medication=[Medication]
'}';
    
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
terminal ID: /[_a-zA-Z][\w_]*/;