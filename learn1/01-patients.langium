grammar PatientList

entry Model:
    patients+=Patient+;

Patient:
    'patient' name=ID 'age' age=INT;

hidden terminal WS: /\s+/;
terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
terminal INT returns number: /[0-9]+/;
