import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createClinicalDslServices } from '../src/clinical-dsl-module.js';
import type { Model } from '../src/generated/ast.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const patient = 'Patient Alice: age 40, condition Fever';
const consumer = `${patient}\nPlan P: for Alice, prescribe DEMOMED\nshow P`;
const medication = (name: string, amount: number) => `Medication ${name}: dose ${amount}mg, route PO, frequency BID`;

async function workspace(files: Array<[string, string]>) {
    const directory = await mkdtemp(join(tmpdir(), 'clinical-scope-'));
    directories.push(directory);
    const services = createClinicalDslServices(NodeFileSystem);
    const uris = new Map<string, URI>();
    const documents: LangiumDocument<Model>[] = [];
    for (const [name, text] of files) {
        const uri = URI.file(join(directory, name));
        uris.set(name, uri);
        await writeFile(uri.fsPath, text);
        documents.push(await services.shared.workspace.LangiumDocuments.getOrCreateDocument(uri) as LangiumDocument<Model>);
    }
    await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
    return {
        services, uris,
        doc(name: string) { return services.shared.workspace.LangiumDocuments.getDocument(uris.get(name)!) as LangiumDocument<Model>; },
        async write(name: string, text: string) {
            const uri = URI.file(join(directory, name));
            uris.set(name, uri);
            await writeFile(uri.fsPath, text);
            await services.shared.workspace.DocumentBuilder.update([uri], []);
        },
        async remove(name: string) {
            const uri = uris.get(name)!;
            await rm(uri.fsPath);
            await services.shared.workspace.DocumentBuilder.update([], [uri]);
        }
    };
}

function errors(document: LangiumDocument) {
    const messages = (document.diagnostics ?? []).filter(item => item.severity === 1).map(item => typeof item.message === 'string' ? item.message : item.message.value);
    expect(messages.filter(message => /error occurred during validation/i.test(message))).toEqual([]);
    return messages;
}

describe('case-insensitive workspace references', () => {
    test.each([false, true])('rejects global ambiguity regardless of load order: reversed=%s', async reverse => {
        const definitions: Array<[string, string]> = [
            ['a.clinical', medication('DemoMed', 10)], ['b.clinical', medication('demomed', 20)]
        ];
        if (reverse) definitions.reverse();
        const ws = await workspace([...definitions, ['consumer.clinical', consumer]]);
        const doc = ws.doc('consumer.clinical');
        expect(doc.parseResult.value.plan[0].medication.ref).toBeUndefined();
        expect(errors(doc)).toContain('Ambiguous medication reference "DEMOMED": 2 visible declarations match ignoring case. Rename the conflicting declarations or use a unique local declaration.');
        const plan = doc.parseResult.value.plan[0];
        const suggestions = ws.services.ClinicalDsl.references.ScopeProvider.getScope({container: plan, property: 'medication', reference: plan.medication}).getAllElements().toArray();
        expect(suggestions.map(item => item.name.toLowerCase())).not.toContain('demomed');
    });

    test('keeps local declarations ahead of global names while rejecting local duplicates', async () => {
        const ws = await workspace([
            ['a.clinical', medication('DemoMed', 10)],
            ['consumer.clinical', `${medication('demomed', 20)}\n${consumer}`]
        ]);
        expect(errors(ws.doc('consumer.clinical'))).toEqual([]);
        expect(ws.doc('consumer.clinical').parseResult.value.plan[0].medication.ref?.amount).toBe(20);
        await ws.write('consumer.clinical', `${medication('demomed', 20)}\n${medication('DemoMed', 30)}\n${consumer}`);
        expect(ws.doc('consumer.clinical').parseResult.value.plan[0].medication.ref).toBeUndefined();
        expect(errors(ws.doc('consumer.clinical')).some(message => /Ambiguous medication reference/.test(message))).toBe(true);
    });

    test('relinks an already resolved reference when a conflicting file is added, renamed and removed', async () => {
        const ws = await workspace([
            ['a.clinical', medication('DemoMed', 10)], ['consumer.clinical', consumer]
        ]);
        expect(errors(ws.doc('consumer.clinical'))).toEqual([]);
        expect(ws.doc('consumer.clinical').parseResult.value.plan[0].medication.ref?.amount).toBe(10);

        await ws.write('b.clinical', medication('demomed', 20));
        expect(errors(ws.doc('consumer.clinical')).some(message => /Ambiguous medication reference/.test(message))).toBe(true);
        expect(ws.doc('consumer.clinical').parseResult.value.plan[0].medication.ref).toBeUndefined();

        await ws.write('b.clinical', medication('OtherMed', 20));
        expect(errors(ws.doc('consumer.clinical'))).toEqual([]);
        expect(ws.doc('consumer.clinical').parseResult.value.plan[0].medication.ref?.amount).toBe(10);

        await ws.write('b.clinical', medication('DEMOMED', 20));
        expect(ws.doc('consumer.clinical').parseResult.value.plan[0].medication.ref).toBeUndefined();
        await ws.remove('b.clinical');
        expect(errors(ws.doc('consumer.clinical'))).toEqual([]);
        expect(ws.doc('consumer.clinical').parseResult.value.plan[0].medication.ref?.amount).toBe(10);
    });

    test('relinks an untitled clinical editor when a conflicting file is added or removed', async () => {
        const ws = await workspace([['a.clinical', medication('DemoMed', 10)]]);
        const uri = URI.parse('untitled:Untitled-1');
        const text = TextDocument.create(uri.toString(), 'clinical-dsl', 1, consumer);
        const openDocuments = ws.services.shared.workspace.TextDocuments;
        const originalGet = openDocuments.get.bind(openDocuments);
        vi.spyOn(openDocuments, 'get').mockImplementation(resource =>
            resource.toString() === uri.toString() ? text : originalGet(resource));
        const document = ws.services.shared.workspace.LangiumDocumentFactory.fromTextDocument(text, uri) as LangiumDocument<Model>;
        ws.services.shared.workspace.LangiumDocuments.addDocument(document);
        await ws.services.shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect(errors(document)).toEqual([]);
        expect(document.parseResult.value.plan[0].medication.ref?.amount).toBe(10);

        await ws.write('b.clinical', medication('demomed', 20));
        expect(document.parseResult.value.plan[0].medication.ref).toBeUndefined();
        expect(errors(document).some(message => /Ambiguous medication reference/.test(message))).toBe(true);
        await ws.remove('b.clinical');
        expect(errors(document)).toEqual([]);
        expect(document.parseResult.value.plan[0].medication.ref?.amount).toBe(10);
    });

    test('rejects global patient and plan ambiguities with useful diagnostics', async () => {
        const ws = await workspace([
            ['a.clinical', `${patient}\n${medication('DrugA', 10)}\nPlan DemoPlan: for Alice, prescribe DrugA`],
            ['b.clinical', `Patient alice: age 50, condition Fever\n${medication('DrugB', 20)}\nPlan demoplan: for alice, prescribe DrugB`],
            ['consumer.clinical', `${medication('DrugC', 5)}\nPlan Consumer: for ALICE, prescribe DrugC\nshow DEMOPLAN`]
        ]);
        expect(errors(ws.doc('consumer.clinical')).some(message => /Ambiguous patient reference/.test(message))).toBe(true);
        expect(errors(ws.doc('consumer.clinical')).some(message => /Ambiguous plan reference/.test(message))).toBe(true);
        expect(errors(ws.doc('a.clinical'))).toEqual([]);
        expect(errors(ws.doc('b.clinical'))).toEqual([]);
    });

    test.each(['show', 'show '])('an unfinished display statement does not throw during validation: %s', async source => {
        const ws = await workspace([['broken.clinical', source]]);
        expect(errors(ws.doc('broken.clinical')).length).toBeGreaterThan(0);
    });

    test('a missing Patient name produces syntax errors, not a validator exception', async () => {
        const ws = await workspace([['broken.clinical', 'Patient : age 40, condition Fever']]);
        expect(errors(ws.doc('broken.clinical')).length).toBeGreaterThan(0);
    });
});
