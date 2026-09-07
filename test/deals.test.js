import test from 'node:test';
import assert from 'node:assert/strict';

import { incomingDealFromForm, outgoingDealFromForm } from '../src/adapters/deals.js';
import { projectDealAffordability, projectDealRisks } from '../src/lib/deal-safety.js';
import { dealsModule } from '../src/ui/deals.js';

function cellsRow(name, amount) {
    const cells = [{ textContent: name }, { textContent: amount }];
    return { querySelectorAll: (selector) => selector === 'td' ? cells : [] };
}

function node(kind, value = null) {
    return {
        previousElementSibling: null,
        parentElement: null,
        matches(selector) {
            return (selector === 'form' && kind === 'form')
                || (selector === 'table' && kind === 'table')
                || (selector === 'center' && kind === 'center');
        },
        querySelector(selector) {
            if (selector === 'form') return value && value.form || null;
            if (selector === 'table') return kind === 'table-wrap' ? value : null;
            if (selector === 'h4') return kind === 'heading' ? { textContent: value } : null;
            if (kind === 'form' && selector.includes('acceptdeal')) return value.accept;
            if (kind === 'form' && selector === 'input[name="deal_id"]') return value.dealId;
            return null;
        },
        querySelectorAll(selector) {
            if (kind === 'table' && selector === 'tr') return value;
            return [];
        },
    };
}

test('associates offered and requested resource tables with an incoming deal form', () => {
    const offeredHeading = node('heading', 'Offered Items');
    const offeredTable = node('table', [cellsRow('Apples', '1,200')]);
    const offeredWrap = node('table-wrap', offeredTable);
    const requestedHeading = node('heading', 'Requested Items');
    const requestedTable = node('table', [cellsRow('Copper', '350')]);
    const requestedWrap = node('table-wrap', requestedTable);
    const accept = { name: 'acceptdeal', value: 'Accept Deal' };
    const form = node('form', { accept, dealId: { value: '42' } });
    const chain = [offeredHeading, offeredWrap, requestedHeading, requestedWrap, form];
    for (let i = 1; i < chain.length; i += 1) chain[i].previousElementSibling = chain[i - 1];

    const deal = incomingDealFromForm(form);
    assert.equal(deal.dealId, '42');
    assert.deepEqual(deal.offered, [{ name: 'Apples', amount: 1200 }]);
    assert.deepEqual(deal.requested, [{ name: 'Copper', amount: 350 }]);
});

test('reads the requested bits for each incoming deal, including money-only deals', () => {
    const previousForm = node('form', {});
    const moneyLine = node('money');
    moneyLine.previousElementSibling = previousForm;
    const form = node('form', { accept: { name: 'acceptdeal' }, dealId: { value: '42' } });
    form.previousElementSibling = moneyLine;
    moneyLine.textContent = 'requests 1,200,000 bits from you for this deal';
    assert.equal(incomingDealFromForm(form).bitsRequested, 1200000);
    moneyLine.textContent = 'offers 1,200,000 bits for this deal';
    assert.equal(incomingDealFromForm(form).bitsRequested, 0);
    moneyLine.textContent = 'does not involve money in this deal';
    assert.equal(incomingDealFromForm(form).bitsRequested, 0);
    moneyLine.textContent = 'Unrecognized money format';
    assert.equal(incomingDealFromForm(form).bitsRequested, null);
});

test('deal affordability combines money, resource, weapon and armor shortages', () => {
    const stats = {
        funds: 100, byName: { copper: { qty: 5 } },
        weaponsByName: { 'scrounged weapons': { qty: 2 } },
        armorByName: { 'scrounged armor': { qty: 1 } },
    };
    const deal = { bitsRequested: 200, requested: [
        { name: 'Copper', amount: 10 },
        { name: 'Scrounged Weapons', amount: 3 },
        { name: 'Scrounged Armor', amount: 3 },
    ] };
    assert.deepEqual(projectDealAffordability(deal, stats), [
        { name: 'Bits', required: 200, stock: 100, shortage: 100 },
        { name: 'Copper', required: 10, stock: 5, shortage: 5 },
        { name: 'Scrounged Armor', required: 3, stock: 1, shortage: 2 },
        { name: 'Scrounged Weapons', required: 3, stock: 2, shortage: 1 },
    ]);
    assert.deepEqual(projectDealAffordability({ bitsRequested: 100 }, stats), []);
    assert.deepEqual(projectDealAffordability({ bitsRequested: 0 }, stats), []);
    assert.deepEqual(projectDealAffordability({ bitsRequested: 200 }, { ...stats, funds: null }), []);
    assert.deepEqual(projectDealAffordability({ requested: [{ name: 'Scrounged Weapons', amount: 3 }] }, {
        byName: {}, weaponsByName: {}, armorByName: {},
    }), [{ name: 'Scrounged Weapons', required: 3, stock: 0, shortage: 3 }]);
});

test('warns when accepting a deal would spend stock below its reserve', () => {
    const risks = projectDealRisks({
        offered: [],
        requested: [{ name: 'Copper', amount: 15 }],
    }, {
        byName: {
            copper: { name: 'Copper', qty: 35, used: 20, mil: 4 },
        },
    });

    assert.deepEqual(risks, [{
        name: 'Copper',
        stockBefore: 35,
        stockAfter: 20,
        stockChange: -15,
        reserveBefore: 24,
        reserveAfter: 24,
        reserveChange: 0,
        shortage: 4,
    }]);
});

test('nets resources received in the same deal and ignores non-resource rows', () => {
    const risks = projectDealRisks({
        offered: [{ name: 'Cider', amount: 10 }],
        requested: [
            { name: 'Cider', amount: 12 },
            { name: 'Scrounged Weapons', amount: 50 },
        ],
    }, {
        byName: {
            cider: { name: 'Cider', qty: 14, used: 12, mil: 0 },
        },
    });
    assert.deepEqual(risks, [], 'the net two-cider cost lands exactly on the reserve');
});

test('does not warn about a pre-existing shortage which the deal improves', () => {
    const risks = projectDealRisks({
        offered: [{ name: 'Apples', amount: 2 }],
        requested: [],
    }, {
        byName: {
            apples: { name: 'Apples', qty: 5, used: 10, mil: 0 },
        },
    });
    assert.deepEqual(risks, []);
});

test('checks deal affordability before crediting offered items and keeps hypothetical upkeep', () => {
    const deal = {
        offered: [{ name: 'Cider', amount: 8 }],
        requested: [{ name: 'Cider', amount: 10 }],
    };
    const stats = {
        byName: {
            cider: { name: 'Cider', qty: 5, used: 10, mil: 0 },
        },
    };
    assert.deepEqual(projectDealAffordability(deal, stats), [{
        name: 'Cider', required: 10, stock: 5, shortage: 5,
    }]);
    const [risk] = projectDealRisks(deal, stats);
    assert.equal(risk.stockAfter, 3);
    assert.equal(risk.shortage, 7);
});

test('collects every known resource shortage in a deal without treating weapons as resources', () => {
    assert.deepEqual(projectDealAffordability({ requested: [
        { name: 'Copper', amount: 20 }, { name: 'Copper', amount: 30 },
        { name: 'Apples', amount: 10 }, { name: 'Scrounged Weapons', amount: 100 },
    ] }, { byName: {
        copper: { qty: 35 }, apples: { qty: 0 },
    } }), [
        { name: 'Apples', required: 10, stock: 0, shortage: 10 },
        { name: 'Copper', required: 50, stock: 35, shortage: 15 },
    ]);
});

test('recognizes zero-stock resources omitted from Overview without guessing unknown deal items', () => {
    assert.deepEqual(projectDealAffordability({ requested: [
        { name: 'Copper', amount: 50 }, { name: 'Scrounged Weapons', amount: 10 },
    ] }, { byName: {} }), [{ name: 'Copper', required: 50, stock: 0, shortage: 50 }]);
});

test('offers deal upkeep protection as a default-on setting', () => {
    const definitions = [];
    dealsModule.settings({ settings: { define: (definition) => definitions.push(definition) } });
    assert.deepEqual(definitions.map(({ key, type, default: defaultValue, section }) => ({
        key, type, default: defaultValue, section,
    })), [{
        key: 'deals.confirmBelowUpkeep', type: 'bool', default: true, section: 'Deals',
    }]);
});

function outgoingForm(intent = 'offeritem', amount = '15', name = 'Copper (Have 35)') {
    const listeners = {};
    const button = { name: intent, value: 'Original button label', disabled: false };
    const fields = {
        amount: { value: amount, disabled: false },
        resource_id: { value: '12', selectedOptions: [{ textContent: name }], disabled: false },
        token_makedeal: { value: 'original-token', disabled: false },
        deal_id: { value: '42', disabled: false },
    };
    const form = {
        button, fields, listeners, appended: [],
        classList: { toggle() {} },
        querySelector(selector) {
            if (selector === '[name="offeritem"], [name="askitem"], [name="offermoney"]') {
                return ['offeritem', 'askitem', 'offermoney'].includes(intent) ? button : null;
            }
            const key = selector.match(/^(?:input|select)\[name="([^"]+)"\]$/)?.[1];
            return fields[key] || null;
        },
        querySelectorAll() { return [...Object.values(fields), button]; },
        addEventListener(name, handler) { listeners[name] = handler; },
        appendChild(node) { this.appended.push(node); },
    };
    button.form = form;
    return form;
}

test('outgoing offers project immediate resource costs and fees, not eventual proceeds', () => {
    const form = outgoingForm();
    const deal = outgoingDealFromForm(form, form.button);
    assert.deepEqual(deal, {
        offered: [], requested: [{ name: 'Copper', amount: 15 }], bitsRequested: 1500,
        operation: 'Offer 15 Copper',
    });
    const stats = { funds: 1000, byName: { copper: { qty: 35, used: 20, mil: 4 } } };
    assert.equal(projectDealRisks(deal, stats)[0].shortage, 4);
    assert.deepEqual(projectDealAffordability(deal, stats), [
        { name: 'Bits', required: 1500, stock: 1000, shortage: 500 },
    ]);
    form.fields.amount.value = '50';
    const updated = outgoingDealFromForm(form, form.button);
    assert.equal(updated.requested[0].amount, 50, 'read the latest edited amount');
    assert.equal(projectDealRisks(updated, stats)[0].shortage, 39);
    assert.equal(projectDealAffordability(updated, stats).length, 2);
});

test('outgoing requests cost only fees, money offers cost bits, and equipment uses inventory', () => {
    const request = outgoingForm('askitem');
    assert.deepEqual(outgoingDealFromForm(request, request.button), {
        offered: [], requested: [], bitsRequested: 1500, operation: 'Request 15 Copper',
    });
    const money = outgoingForm('offermoney', '15000');
    assert.deepEqual(outgoingDealFromForm(money, money.button), {
        offered: [], requested: [], bitsRequested: 15000, operation: 'Offer 15,000 Bits',
    });
    const weapon = outgoingForm('offeritem', '3', 'Scrounged Weapons (Have 1,000)');
    const deal = outgoingDealFromForm(weapon, weapon.button);
    const stats = { funds: 300, byName: {}, weaponsByName: { 'scrounged weapons': { qty: 2 } } };
    assert.deepEqual(projectDealRisks(deal, stats), []);
    assert.deepEqual(projectDealAffordability(deal, stats), [
        { name: 'Scrounged Weapons', required: 3, stock: 2, shortage: 1 },
    ]);
});

test('does not charge again on finalize, or protect returning stock and requesting money', () => {
    for (const intent of ['finalizedeal', 'canceldeal', 'removeoffer', 'removeask', 'removemoney', 'requestmoney']) {
        const form = outgoingForm(intent);
        assert.equal(outgoingDealFromForm(form, form.button), null);
    }
    for (const amount of ['', '0', '-2']) {
        const form = outgoingForm('offeritem', amount);
        assert.equal(outgoingDealFromForm(form, form.button), null);
    }
    for (const amount of ['1,000', '15oops', '1.5', 'Infinity', '9007199254740992']) {
        const form = outgoingForm('offeritem', amount);
        assert.throws(() => outgoingDealFromForm(form, form.button), /quantity/);
    }
    const missing = outgoingForm();
    missing.fields.resource_id.selectedOptions = [];
    assert.throws(() => outgoingDealFromForm(missing, missing.button), /selected/);
});

function safetyHarness(t, { amount = '15', funds = 10000, enabled = true, fail = false, intent = 'offeritem' } = {}) {
    const form = outgoingForm(intent, amount);
    if (intent === 'acceptdeal') {
        const query = form.querySelector.bind(form);
        form.querySelector = (selector) => selector.includes('acceptdeal') ? form.button
            : selector === 'input[name="token_makedeal"]' ? null : query(selector);
        const heading = node('heading', 'Requested Items');
        const table = node('table-wrap', node('table', [cellsRow('Copper', amount)]));
        table.previousElementSibling = heading;
        form.previousElementSibling = table;
    }
    const cancel = outgoingForm('canceldeal');
    cancel.fields.amount.disabled = true; // Restore pre-existing disabled state too.
    const headers = ['Resource', 'Qty', 'Generated', 'Used', 'Net'].map((textContent) => ({ textContent }));
    const row = { querySelectorAll: () => ['Copper', '35', '0', '24', '-24'].map((textContent) => ({ textContent })) };
    const table = { querySelectorAll: (selector) => selector === 'tbody tr' ? [row] : headers };
    const resourcePanel = {
        querySelector: (selector) => selector === '.panel-heading' ? { textContent: 'Resources' } : table,
        querySelectorAll: () => [],
    };
    const nationPanel = {
        querySelector: () => ({ textContent: 'Nation' }),
        querySelectorAll: () => [cellsRow('Funds', `${funds} bits`)],
    };
    const originalDoc = globalThis.document;
    const originalForm = globalThis.HTMLFormElement;
    const submissions = [];
    globalThis.document = { querySelectorAll: () => [form, cancel] };
    globalThis.HTMLFormElement = { prototype: { submit() {
        assert.equal(form.fields.amount.disabled, false, 'enable fields before native serialization');
        submissions.push(this);
    } } };
    t.after(() => {
        if (originalDoc === undefined) delete globalThis.document;
        else globalThis.document = originalDoc;
        if (originalForm === undefined) delete globalThis.HTMLFormElement;
        else globalThis.HTMLFormElement = originalForm;
    });
    let allow = false;
    const confirmations = [];
    let fetches = 0;
    const core = {
        el: (tag, attrs, children) => ({ tag, attrs, children }),
        commas: (value) => value.toLocaleString('en-US'),
        addStyle() {}, settings: { get: () => enabled }, events: { emit() {} },
        http: { async getDoc(url) {
            fetches++;
            assert.equal(url, 'overview.php');
            assert.equal(form.fields.amount.disabled, true);
            assert.equal(cancel.button.disabled, true);
            if (fail) throw new Error('Network unavailable');
            return { querySelectorAll: () => [resourcePanel, nationPanel] };
        } },
        async confirm(options) { confirmations.push(options); return allow; },
    };
    dealsModule.init(core);
    return {
        form, cancel, confirmations, submissions,
        allow() { allow = true; },
        fetches: () => fetches,
        async submit(fallback = false) {
            let prevented = false;
            if (fallback) form.listeners.click({ target: { closest: () => form.button } });
            await form.listeners.submit({
                submitter: fallback ? undefined : form.button,
                preventDefault() { prevented = true; },
            });
            assert.equal(prevented, true);
        },
    };
}

test('outgoing submission reuses upkeep confirmation, supports cancel/retry, and preserves POST fields', async (t) => {
    assert.equal(dealsModule.matches('makedeal.php'), true);
    assert.equal(dealsModule.matches('deals.php'), true);
    assert.equal(dealsModule.matches('overview.php'), false);
    const h = safetyHarness(t);
    await h.submit();
    assert.equal(h.submissions.length, 0);
    assert.equal(h.confirmations[0].title, 'Review action: Offer 15 Copper');
    assert.equal(h.confirmations[0].confirmLabel, 'Add anyway');
    assert.equal(h.form.button.value, 'Original button label');
    assert.equal(h.form.fields.amount.disabled, false);
    assert.equal(h.cancel.button.disabled, false);
    assert.equal(h.cancel.fields.amount.disabled, true);
    h.allow();
    await h.submit(true);
    assert.equal(h.submissions.length, 1);
    assert.equal(h.fetches(), 2);
    assert.deepEqual(h.form.appended[0].attrs, {
        type: 'hidden', name: 'offeritem', value: 'Original button label',
    });
    assert.equal(h.form.fields.amount.value, '15');
    assert.equal(h.form.fields.token_makedeal.value, 'original-token');
});

test('safe outgoing offers submit without prompting', async (t) => {
    const h = safetyHarness(t, { amount: '10' });
    await h.submit();
    assert.equal(h.submissions.length, 1);
    assert.equal(h.confirmations.length, 0);
});

test('the shared handler still protects incoming acceptance', async (t) => {
    const h = safetyHarness(t, { intent: 'acceptdeal' });
    await h.submit();
    assert.equal(h.submissions.length, 0);
    assert.equal(h.confirmations[0].title, 'Review action: Accept deal');
    assert.equal(h.confirmations[0].confirmLabel, 'Accept anyway');
    h.allow();
    await h.submit();
    assert.equal(h.submissions.length, 1);
    assert.equal(h.form.appended[0].attrs.name, 'acceptdeal');
});

test('repeated submission during a safety check cannot submit twice', async (t) => {
    const h = safetyHarness(t, { amount: '10' });
    await Promise.all([h.submit(), h.submit()]);
    assert.equal(h.fetches(), 1);
    assert.equal(h.submissions.length, 1);
});

test('disabling deal upkeep permits affordable offers below upkeep', async (t) => {
    const h = safetyHarness(t, { enabled: false });
    await h.submit();
    assert.equal(h.submissions.length, 1);
    assert.equal(h.confirmations.length, 0);
});

test('adding a requested resource checks fees but never spends the requested stock', async (t) => {
    const h = safetyHarness(t, { intent: 'askitem', amount: '50' });
    await h.submit();
    assert.equal(h.submissions.length, 1);
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.form.appended[0].attrs.name, 'askitem');
});

test('money offers use the same affordability dialog', async (t) => {
    const h = safetyHarness(t, { intent: 'offermoney', amount: '50000' });
    await h.submit();
    assert.equal(h.submissions.length, 0);
    assert.equal(h.confirmations[0].title, 'Action was not performed: Offer 50,000 Bits');
});

test('upkeep toggle suppresses only upkeep; fee affordability still blocks', async (t) => {
    const h = safetyHarness(t, { enabled: false, funds: 100 });
    await h.submit();
    assert.equal(h.submissions.length, 0);
    assert.match(h.confirmations[0].title, /^Action was not performed: Offer 15 Copper$/);
    assert.equal(h.confirmations[0].reviewBeforeConfirm, null);
});

test('affordability keeps hypothetical upkeep behind the normal expandable review', async (t) => {
    const h = safetyHarness(t, { amount: '50' });
    await h.submit();
    assert.equal(h.submissions.length, 0);
    assert.match(h.confirmations[0].title, /^Action was not performed/);
    assert.equal(h.confirmations[0].reviewBeforeConfirm.summary, 'Attempt anyway — review 1 safety warning');
});

test('unavailable Overview requires explicit bypass and restores controls after cancellation', async (t) => {
    const h = safetyHarness(t, { fail: true });
    await h.submit();
    assert.equal(h.submissions.length, 0);
    assert.equal(h.confirmations[0].title, 'Deal safety unavailable');
    assert.equal(h.form.fields.amount.disabled, false);
    h.allow();
    await h.submit();
    assert.equal(h.submissions.length, 1);
});
