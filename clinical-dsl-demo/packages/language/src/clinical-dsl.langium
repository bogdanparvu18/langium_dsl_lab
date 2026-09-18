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