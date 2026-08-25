import test from 'node:test';
import assert from 'node:assert/strict';

import {
    saleWouldDipBelowReserve, sellRevenueAfterTax, unitPriceForSellRevenue,
} from '../src/ui/marketplace.js';

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
