import test from 'node:test';
import assert from 'node:assert/strict';

import { incomingDealFromForm } from '../src/adapters/deals.js';
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
