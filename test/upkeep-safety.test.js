import test from 'node:test';
import assert from 'node:assert/strict';

import {
    affordabilityShortage, protectedReserve, reserveSafeMax, upkeepRiskForChange,
} from '../src/lib/upkeep-safety.js';

test('combines tick consumption and military upkeep into one reserve', () => {
    assert.equal(protectedReserve({ used: 20, mil: 4 }), 24);
    assert.equal(protectedReserve({ used: 20 }), 20);
});

test('calculates the largest whole operation count above a reserve', () => {
    assert.equal(reserveSafeMax(24, 4, 5), 4);
    assert.equal(reserveSafeMax(23, 4, 5), 3);
    assert.equal(reserveSafeMax(24, 4), 20);
    assert.equal(reserveSafeMax(3, 4), 0);
    assert.equal(reserveSafeMax(10, 2, 0), null);
});

test('classifies a stock change that crosses the protected reserve', () => {
    const resource = { name: 'Copper', qty: 35, used: 20, mil: 4 };
    assert.deepEqual(upkeepRiskForChange(resource, { stockChange: -15 }), {
        name: 'Copper',
        stockBefore: 35,
        stockAfter: 20,
        stockChange: -15,
        reserveBefore: 24,
        reserveAfter: 24,
        reserveChange: 0,
        shortage: 4,
    });
});

test('treats the exact reserve boundary as safe', () => {
    const resource = { name: 'Cider', qty: 150, used: 100, mil: 0 };
    assert.equal(upkeepRiskForChange(resource, { stockChange: -50 }), null);
    assert.equal(upkeepRiskForChange(resource, { stockChange: -51 }).shortage, 1);
});

test('classifies upkeep increases as well as stock spending', () => {
    const risk = upkeepRiskForChange({ name: 'Energy', qty: 48, used: 32, mil: 0 }, {
        reserveChange: 24,
    });
    assert.equal(risk.stockAfter, 48);
    assert.equal(risk.reserveAfter, 56);
    assert.equal(risk.shortage, 8);
});

test('ignores unrelated shortages but includes upkeep for unaffordable operations', () => {
    const alreadyShort = { name: 'Apples', qty: 5, used: 10, mil: 0 };
    assert.equal(upkeepRiskForChange(alreadyShort), null);
    assert.equal(upkeepRiskForChange(alreadyShort, { stockChange: 2 }), null);
    assert.equal(upkeepRiskForChange(alreadyShort, { stockChange: -6 }).shortage, 11);
    assert.equal(upkeepRiskForChange(alreadyShort, { stockChange: -1 }).shortage, 6,
        'worsening an existing shortage still warns');
});

test('distinguishes entry-cost shortages from the extra stock needed for upkeep', () => {
    const copper = { name: 'Copper', qty: 35, used: 10, mil: 0 };
    assert.deepEqual(affordabilityShortage(copper, 50), {
        name: 'Copper', required: 50, stock: 35, shortage: 15,
    });
    const risk = upkeepRiskForChange(copper, { stockChange: -50 });
    assert.equal(risk.stockAfter, -15);
    assert.equal(risk.shortage, 25);
    assert.equal(affordabilityShortage(copper, 35), null);
    assert.equal(upkeepRiskForChange({ ...copper, used: 0 }, { stockChange: -50 }), null,
        'zero upkeep should not duplicate an affordability error');
});

test('does not invent affordability errors from unknown stock or invalid counts', () => {
    assert.equal(affordabilityShortage(null, 5), null);
    assert.equal(affordabilityShortage({}, 5), null);
    assert.equal(affordabilityShortage({ qty: 'unknown' }, 5), null);
    assert.equal(affordabilityShortage({ qty: 0 }, NaN), null);
    assert.equal(affordabilityShortage({ qty: 0 }, Infinity), null);
    assert.equal(affordabilityShortage({ qty: 0 }, -1), null);
});
