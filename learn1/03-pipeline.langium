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
