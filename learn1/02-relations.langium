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
