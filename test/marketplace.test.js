import test from 'node:test';
import assert from 'node:assert/strict';

import {
    marketPurchaseShortage, performMarketPurchase, negativeNetConfirmationEnabled, orderShouldStayEmphasized,
    saleResourceRisks, sellRevenueAfterTax, unitPriceForSellRevenue,
} from '../src/ui/marketplace.js';
import {
    createMarketAdapter, marketMessagesFromDocument, marketResourceFromLocation, marketResourcesFromDocument,
    marketViewUrl, summarizeFriendly,
} from '../src/adapters/market.js';
import {
    buyerResourceHasSpare, friendlyTotals, liveUpdatesModule,
    marketBadgeAccentForStockColor, watchedOrderTotals, writeFriendlyCacheEntry,
} from '../src/ui/liveupdates.js';

test('market purchase affordability includes tax and rounds the total once, as the server does', () => {
    const snapshot = { funds: '3,152 Bits', mult: { buy: 1.05 } };
    assert.deepEqual(marketPurchaseShortage(snapshot, 3, 1001), {
        name: 'Bits', required: 3153, stock: 3152, shortage: 1,
    });
    assert.equal(marketPurchaseShortage({ ...snapshot, funds: '3,153' }, 3, 1001), null);
    assert.deepEqual(marketPurchaseShortage({ ...snapshot, funds: '0 Bits' }, 1, 1000), {
        name: 'Bits', required: 1050, stock: 0, shortage: 1050,
    });
    assert.throws(() => marketPurchaseShortage({ ...snapshot, funds: null }, 1, 1000));
    assert.throws(() => marketPurchaseShortage({ ...snapshot, mult: null }, 1, 1000));
    assert.throws(() => marketPurchaseShortage(snapshot, Number.MAX_SAFE_INTEGER, 1000));
});

test('purchase and buy-offer preflight sends nothing on dismissal and attempts exactly once on override', async () => {
    let requests = 0;
    let confirmations = 0;
    let allow = false;
    let funds = '100 Bits';
    const adapter = { inspect: async () => ({ funds, mult: { buy: 1.05 } }) };
    const core = {
        el: (tag, attrs, children) => ({ tag, attrs, children }),
        commas: String,
        confirm: async (options) => {
            confirmations += 1;
            assert.equal(options.cancelLabel, 'OK');
            assert.equal(options.confirmLabel, 'Attempt anyway');
            return allow;
        },
    };
    const action = async () => { requests += 1; return { updated: true }; };
    assert.equal(await performMarketPurchase(core, adapter, '2', '1000', action), null);
    assert.equal(requests, 0);
    allow = true;
    assert.deepEqual(await performMarketPurchase(core, adapter, '2', '1000', action), { updated: true });
    assert.equal(requests, 1);
    assert.equal(confirmations, 2, 'only one dialog per attempt');
    funds = '2,100 Bits';
    await performMarketPurchase(core, adapter, '2', '1000', action);
    assert.equal(requests, 2);
    assert.equal(confirmations, 2, 'an affordable purchase does not ask for confirmation');
    adapter.inspect = async () => { throw new Error('Offline'); };
    await assert.rejects(performMarketPurchase(core, adapter, '2', '1000', action), /Offline/);
    assert.equal(requests, 2);
});

test('preflight refreshes funds, tax and stock with GET for both sides and every marketplace mode', async () => {
    for (const side of ['sell', 'buyer']) {
        for (const mode of ['', 'weapons', 'armor']) {
            const calls = [];
            const doc = {
                querySelector: (selector) => selector === 'input[name^="token_"]'
                    ? { value: 'fresh', getAttribute: () => 'token_marketplace' } : null,
                querySelectorAll: (selector) => {
                    if (selector === '#content .well') return [{
                        textContent: 'Funds: 25,000 Bits',
                        querySelector: () => ({ textContent: '25,000 Bits' }),
                    }];
                    if (selector === '#content .alert-info') return [{
                        textContent: 'Due to your economic type, you will pay 5% more and receive 5% less.',
                    }];
                    if (selector === 'select[name="resource_id"] option') return [{
                        value: '2', textContent: 'Item (Have 12)', hasAttribute: () => false,
                    }];
                    return [];
                },
            };
            const adapter = createMarketAdapter({ http: {
                getDoc: async (url) => { calls.push(url); return doc; },
                postForm: () => assert.fail('inspection must not submit an action'),
            } }, side, mode);
            const snapshot = await adapter.inspect();
            assert.deepEqual(calls, [`${side === 'sell' ? '' : 'buyer'}marketplace.php${mode ? `?mode=${mode}` : ''}`]);
            assert.equal(snapshot.funds, '25,000 Bits');
            assert.equal(snapshot.mult.buy, 1.05);
            assert.equal(snapshot.resources[0].have, 12);
        }
    }
});

test('uses green market badges only when the game theme already uses blue badges', () => {
    assert.equal(marketBadgeAccentForStockColor('rgb(42, 159, 214)'), '#5cb85c');
    assert.equal(marketBadgeAccentForStockColor('rgb(122, 130, 136)'), '#5bc0de');
    assert.equal(marketBadgeAccentForStockColor('rgb(153, 153, 153)'), '#5bc0de');
    assert.equal(marketBadgeAccentForStockColor('transparent'), '#5bc0de');
});

test('offers contrasting-accent and stock-theme market badge styles', () => {
    const definitions = [];
    liveUpdatesModule.settings({ settings: { define: (definition) => definitions.push(definition) } });

    const badgeSetting = definitions.find(({ key }) => key === 'market.blueBadges');
    assert.deepEqual(badgeSetting.options.map(({ value, label }) => ({ value, label })), [
        { value: '1', label: 'Accent' },
        { value: '0', label: 'Stock' },
    ]);
    assert.equal(badgeSetting.options[0].example.class, 'clop-choice-example-accent');
    assert.equal(badgeSetting.options[1].example.stock, true);
});

test('extracts marketplace server feedback as clean text', () => {
    const error = { textContent: '  Too   many\norders.  ' };
    const info = { textContent: ' Order placed. ' };
    const doc = {
        querySelectorAll(selector) {
            if (selector === '#content .alert-danger div.error') return [error];
            if (selector === '#content .alert-info div.info') return [info];
            return [];
        },
    };

    assert.deepEqual(marketMessagesFromDocument(doc), {
        errors: ['Too   many\norders.'],
        infos: ['Order placed.'],
    });
});

test('calculates the lowest unit price that meets an after-tax revenue target', () => {
    const price = unitPriceForSellRevenue(10, 1000, 0.95);

    assert.equal(price, 106);
    assert.equal(sellRevenueAfterTax(10, price, 0.95), 1007);
    assert.equal(sellRevenueAfterTax(10, price - 1, 0.95), 997);
});

test('keeps an exact unit price when it lands exactly on the target', () => {
    assert.equal(unitPriceForSellRevenue(10, 950, 0.95), 100);
});

test('rounds up when whole unit prices cannot produce the exact total', () => {
    assert.equal(unitPriceForSellRevenue(3, 10, 1), 4);
});

test('rejects invalid or unsafe inputs', () => {
    assert.equal(unitPriceForSellRevenue(0, 1000, 0.95), null);
    assert.equal(unitPriceForSellRevenue(10, 0, 0.95), null);
    assert.equal(unitPriceForSellRevenue(10, 1000, 0), null);
    assert.equal(unitPriceForSellRevenue(10, Number.MAX_SAFE_INTEGER, 0.01), null);
});

test('keeps alliance, friend, and own orders emphasized', () => {
    assert.equal(orderShouldStayEmphasized({ own: false, relation: 'alliance' }), true);
    assert.equal(orderShouldStayEmphasized({ own: false, relation: 'friend' }), true);
    assert.equal(orderShouldStayEmphasized({ own: true, relation: null }), true);
    assert.equal(orderShouldStayEmphasized({ own: false, relation: 'enemy' }), false);
    assert.equal(orderShouldStayEmphasized({ own: false, relation: null }), false);
});

test('applies negative-production confirmation modes to Max and ordinary sales', () => {
    assert.equal(negativeNetConfirmationEnabled('always', false), true);
    assert.equal(negativeNetConfirmationEnabled('always', true), true);
    assert.equal(negativeNetConfirmationEnabled('max', false), false);
    assert.equal(negativeNetConfirmationEnabled('max', true), true);
    assert.equal(negativeNetConfirmationEnabled('never', false), false);
    assert.equal(negativeNetConfirmationEnabled('never', true), false);
});

test('combines upkeep and imported-stockpile sale risks', () => {
    const risks = saleResourceRisks({
        name: 'Oil', qty: 10, used: 5, mil: 0, generated: 0, net: -5,
    }, 'Oil', 8, { checkNegativeNet: true, checkUpkeep: true });

    assert.equal(risks.upkeep.shortage, 3);
    assert.deepEqual(risks.negativeNet, { kind: 'imported', net: -5 });
});

test('does not call a domestically produced net-negative resource imported', () => {
    const risks = saleResourceRisks({
        name: 'Oil', qty: 20, used: 8, mil: 0, generated: 5, net: -3,
    }, 'Oil', 1, { checkNegativeNet: true });

    assert.equal(risks.upkeep, null);
    assert.deepEqual(risks.negativeNet, { kind: 'shrinking', net: -3 });
});

test('parses named market resources and comma-formatted stock amounts', () => {
    const options = [
        { value: '', textContent: 'Pick one', hasAttribute: () => false },
        { value: '7', textContent: 'Coffee (Have 12,345)', hasAttribute: (name) => name === 'selected' },
    ];
    const doc = { querySelectorAll: () => options };

    assert.deepEqual(marketResourcesFromDocument(doc), [{
        id: '7', name: 'Coffee', have: 12345, selected: true,
    }]);
});

test('encodes and reads client-side marketplace deep links', () => {
    assert.equal(marketViewUrl('sell', '', '7'), 'marketplace.php#clopx-market=7');
    assert.equal(marketViewUrl('buyer', 'armor', 'a b'),
        'buyermarketplace.php?mode=armor#clopx-market=a%20b');
    assert.equal(marketResourceFromLocation({ hash: '#clopx-market=a%20b' }), 'a b');
    assert.equal(marketResourceFromLocation({ hash: '#something-else' }), null);
});

test('splits friendly orders into actionable and unavailable totals', () => {
    const orders = [
        { own: false, relation: 'alliance', amount: 10 },
        { own: false, relation: 'friend', amount: 20 },
        { own: false, relation: 'enemy', amount: 30 },
        { own: true, relation: 'friend', amount: 40 },
    ];

    assert.deepEqual(summarizeFriendly(orders, true), {
        count: 2,
        amount: 30,
        unavailableCount: 0,
        unavailableAmount: 0,
        available: true,
    });
    assert.deepEqual(summarizeFriendly(orders, false), {
        count: 0,
        amount: 0,
        unavailableCount: 2,
        unavailableAmount: 30,
        available: false,
    });
});

test('resource buy orders are actionable only with stock above the full reserve', () => {
    const stats = {
        byName: {
            apples: { qty: 100, used: 80, mil: 20 },
            gems: { qty: 101, used: 80, mil: 20 },
        },
    };

    assert.equal(buyerResourceHasSpare(stats, 'Apples'), false);
    assert.equal(buyerResourceHasSpare(stats, 'Gems'), true);
    assert.equal(buyerResourceHasSpare(stats, 'Unknown', false), false);
    assert.equal(buyerResourceHasSpare(null, 'Apples', true), true);
});

test('keeps actionable and unavailable watched-order aggregates separate', () => {
    const previousStorage = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
    };
    try {
        writeFriendlyCacheEntry('', 'buyer', '1', {
            count: 2, amount: 30, unavailableCount: 0, unavailableAmount: 0, available: true,
        }, 'Gems');
        writeFriendlyCacheEntry('', 'buyer', '2', {
            count: 0, amount: 0, unavailableCount: 3, unavailableAmount: 45, available: false,
        }, 'Apples');

        assert.deepEqual(friendlyTotals('', 'buyer'), {
            orders: 2,
            amount: 30,
            unavailableOrders: 3,
            unavailableAmount: 45,
        });
        assert.deepEqual(watchedOrderTotals(), { orders: 2, unavailableOrders: 3 });
    } finally {
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
    }
});
