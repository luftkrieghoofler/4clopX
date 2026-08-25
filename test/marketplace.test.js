import test from 'node:test';
import assert from 'node:assert/strict';

import {
    orderShouldStayEmphasized, saleWouldDipBelowReserve,
    sellRevenueAfterTax, unitPriceForSellRevenue,
} from '../src/ui/marketplace.js';
import { summarizeFriendly } from '../src/adapters/market.js';
import {
    buyerResourceHasSpare, friendlyTotals, watchedOrderTotals, writeFriendlyCacheEntry,
} from '../src/ui/liveupdates.js';

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

test('detects sales that cross the protected reserve boundary', () => {
    assert.equal(saleWouldDipBelowReserve(100, 0, 100), false);
    assert.equal(saleWouldDipBelowReserve(100, 1, 100), true);
    assert.equal(saleWouldDipBelowReserve(150, 50, 100), false);
    assert.equal(saleWouldDipBelowReserve(150, 51, 100), true);
});

test('keeps alliance, friend, and own orders emphasized', () => {
    assert.equal(orderShouldStayEmphasized({ own: false, relation: 'alliance' }), true);
    assert.equal(orderShouldStayEmphasized({ own: false, relation: 'friend' }), true);
    assert.equal(orderShouldStayEmphasized({ own: true, relation: null }), true);
    assert.equal(orderShouldStayEmphasized({ own: false, relation: 'enemy' }), false);
    assert.equal(orderShouldStayEmphasized({ own: false, relation: null }), false);
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
