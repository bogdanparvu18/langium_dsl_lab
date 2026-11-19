import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bound, harness, items, release } from './support/monograph.mjs';

test('accepting confirms the exact DIN; reopening verifies the binding and uses only the local PDF endpoint', async t => {
    const h = await harness(t);
    await h.accept();
    assert.deepEqual(h.requests, [
        { path: '/canadian-products', method: 'GET', query: { release, rxcui: bound.rxcui } },
        { path: '/monograph', method: 'POST', query: { release, rxcui: bound.rxcui, din: '00012346' } }
    ]);
    assert.match(h.notices.at(-1), /DIN 00012346, revised 2025-03-04/);
    assert.equal(h.opened[0].origin, h.origin);
    assert.equal(h.opened[0].pathname, '/monograph.pdf');
    assert.equal(h.opened[0].searchParams.get('din'), '00012346');
    assert.equal(h.opened[0].hash, '#page=14');
    assert.equal(h.memory.size, 1);
    await h.accept();
    assert.equal(h.picks.length, 1, 'same workspace, declaration and product reuse the confirmed DIN');
    await h.reopen();
    assert.equal(h.picks.length, 2, 'reopen offers to change the previous choice when several DINs match');
    assert.match(h.picks.at(-1).at(-1).description, /previously selected/);
});

test('cancelling the presentation picker starts no download and saves no binding', async t => {
    const h = await harness(t, { cancel: true });
    await h.accept();
    assert.equal(h.requests.length, 1);
    assert.equal(h.opened.length, 0);
    assert.equal(h.memory.size, 0);
});

test('stale source identities before and during a pick never retrieve a PDF', async t => {
    const h = await harness(t, { duringPick: ({ edit, document }) => edit(document.getText().replace(bound.rxcui, '900007')) });
    await h.accept();
    assert.deepEqual(h.requests.map(r => r.path), ['/canadian-products']);
    await h.accept();
    assert.equal(h.requests.length, 1);
    assert.equal(h.opened.length, 0);
});

test('edits outside the product binding preserve the lookup and absent headings open the first page', async t => {
    const h = await harness(t, { info: { status: 'available', dosagePage: undefined },
        duringPick: ({ edit, document }) => edit(document.getText().replace('dose 5mg', 'dose 10mg')) });
    await h.accept();
    assert.equal(h.opened[0].origin, h.origin);
    assert.equal(h.opened[0].hash, '');
    assert.match(h.document.getText(), /dose 10mg/);
});

test('the browser opens only a signed URL for the selected DIN and expected PDF digest', async t => {
    for (const url of ['https://other.example/foreign.pdf',
        '/monograph.pdf?release=2026-10-05&rxcui=900001&din=00012345&sha256=' + 'b'.repeat(64) + '&token=' + 'a'.repeat(64)]) {
        const h = await harness(t, { info: { pdfPath: url } });
        await h.reopen();
        assert.equal(h.opened.length, 0);
        assert.match(h.warnings.at(-1), /Invalid cached PDF link/);
    }
});

test('a mismatch in the local RxNorm release or an unavailable official PDF is reported', async t => {
    const mismatch = await harness(t, { candidates: { rxcui: bound.rxcui, rxnormDisplay: 'Different product', release, items } });
    await mismatch.reopen();
    assert.match(mismatch.warnings.at(-1), /Select the product again/);
    assert.equal(mismatch.requests.length, 1);
    const unavailable = await harness(t, { info: { status: 'unavailable' } });
    await unavailable.accept();
    assert.match(unavailable.notices.at(-1), /no electronic monograph/);
    assert.equal(unavailable.opened.length, 0);
});

test('reopening uses the service label for an earlier release-pinned binding and rejects an unpinned id alone', async t => {
    const h = await harness(t);
    h.edit(`Medication Morning: rxcui "${bound.rxcui}" rxnormRelease "${release}"`);
    await h.reopen();
    assert.equal(h.opened.length, 1);
    h.edit(`Medication Morning: rxcui "${bound.rxcui}"`);
    await h.reopen();
    assert.equal(h.requests.length, 2);
    assert.match(h.notices.at(-1), /Place the cursor/);
});

const suggestion = { dose: '20 mg', frequency: 'Q4-6H PRN', page: 16,
    context: 'Example tablets; adult population; maximum stated in the source.',
    evidence: 'Synthetic PDF fixture: 20 mg every 4 to 6 hours as required.' };
const selected = `Medication Morning: product "${bound.display}" rxcui "${bound.rxcui}"`;

test('a selected presentation fills editable fields immediately and offers the exact source page', async t => {
    const h = await harness(t, { info: { regimenSuggestions: [suggestion] },
        noticeAction: (_message, buttons) => buttons.includes('Read source passage') ? 'Read source passage' : buttons[0] });
    h.edit(selected + ' route PO');
    await h.accept();
    assert.equal(h.document.getText(), selected + ' route PO dose 20 mg frequency 4-6H PRN');
    assert.equal(h.editBatches.length, 1);
    assert.equal(h.picks.length, 1, 'the DIN picker is the only selection');
    assert.match(h.notices[0], /PDF p\. 16/);
    assert.ok(h.details[0].includes(suggestion.evidence));
    assert.ok(h.details[0].includes(suggestion.context));
    assert.equal(h.opened[0].hash, '#page=16');
    h.edit(h.document.getText().replace('dose 20 mg', 'dose 10 mg').replace('4-6H PRN', 'BID'));
    await h.reopen();
    assert.match(h.document.getText(), /dose 10 mg frequency BID$/);
    assert.equal(h.editBatches.length, 1, 'manual changes survive a second lookup');
    await h.accept();
    assert.match(h.notices.at(-1), /existing dose and frequency were kept/);
});

test('refusing optional source preview still leaves both fields in the document', async t => {
    const h = await harness(t, { info: { regimenSuggestions: [suggestion] }, noticeAction: () => undefined });
    h.edit(selected);
    await h.accept();
    assert.equal(h.document.getText(), selected + ' dose 20 mg frequency 4-6H PRN');
    assert.equal(h.opened.length, 0);
});

test('auto-fill completes only a compatible partially written order', async t => {
    const h = await harness(t, { info: { regimenSuggestions: [{ ...suggestion, dose: '10 mg', frequency: 'Q8H' }] } });
    h.edit(selected + ' dose 10mg');
    await h.accept();
    assert.equal(h.document.getText(), selected + ' dose 10mg frequency 8H');
    h.edit(selected + ' dose 3mg');
    await h.reopen();
    assert.equal(h.document.getText(), selected + ' dose 3mg');
    h.edit(selected + ' route IV');
    await h.accept();
    assert.equal(h.document.getText(), selected + ' route IV');
});

test('manual edits during lookup, missing evidence and a rejected editor transaction produce no dose draft', async t => {
    for (const overrides of [
        { duringPost: ({ edit, document }) => edit(document.getText() + ' route PO') },
        { info: { regimenSuggestions: [{ ...suggestion, evidence: '' }] } },
        { info: { regimenSuggestions: [] } },
        { info: { regimenSuggestions: [suggestion, { ...suggestion, context: 'A second qualifying population.' }] } },
        { info: { regimenSuggestions: [suggestion, { malformed: true }] } },
        { rejectEdit: true }
    ]) {
        const h = await harness(t, { info: { regimenSuggestions: [suggestion] }, ...overrides });
        h.edit(selected);
        await h.accept();
        assert.equal(h.editBatches.length, 0);
        assert.doesNotMatch(h.document.getText(), / dose | frequency /);
        assert.ok(h.opened[0]);
    }
});
