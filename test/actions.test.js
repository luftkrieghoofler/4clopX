import test from 'node:test';
import assert from 'node:assert/strict';

import { phpInteger } from '../src/adapters/actions.js';
import { ACTION_CATALOG, BUILDING_UPKEEP } from '../src/data/actions.generated.js';
import {
    actionCompatibility, actionNeedsSafetyCheck, projectActionRisks,
} from '../src/lib/action-safety.js';
import { actionsModule } from '../src/ui/actions.js';

test('pairs original action mechanics with their original descriptions', () => {
    assert.equal(Object.keys(ACTION_CATALOG).length, 62);
    assert.equal(ACTION_CATALOG[5].name, 'Build Basic Factory');
    assert.match(ACTION_CATALOG[5].description, /Using 12 energy and 30 copper/);
    assert.deepEqual(ACTION_CATALOG[5].items.map(({ name, amount }) => ({ name, amount })), [
        { name: 'Energy', amount: 12 },
        { name: 'Copper', amount: 30 },
    ]);
    assert.deepEqual(BUILDING_UPKEEP[5], [{ resourceId: 4, name: 'Energy', amount: 1 }]);
});

test('uses the manually verified live DNA-facility rebalance', () => {
    assert.equal(ACTION_CATALOG[51].description,
        'With 1000 machine parts, 750 vehicles, and 500 precision parts, begin extracting DNA from the local ponies and wildlife of the North Burrozilian region. Requires 10 apples per tick. Building more than one causes geometric sat loss from environmental damage.');
    assert.deepEqual(ACTION_CATALOG[51].items.map(({ name, amount }) => ({ name, amount })), [
        { name: 'Machinery Parts', amount: 1000 },
        { name: 'Vehicle Parts', amount: 750 },
        { name: 'Precision Parts', amount: 500 },
    ]);
    for (let buildingId = 50; buildingId <= 61; buildingId += 1) {
        assert.deepEqual(BUILDING_UPKEEP[buildingId], [
            { resourceId: 3, name: 'Apples', amount: 10 },
        ]);
    }
});

test('uses the manually verified live Forbidden Research Facility rebalance', () => {
    const action = ACTION_CATALOG[57];
    assert.match(action.description, /10000 copper, 5000 machinery parts, and 1000 precision parts/);
    assert.match(action.description, /total of 12 DNA, plus 50 gems, tungsten, and copper every tick/);
    assert.equal(action.maxOwned, 1);
    assert.deepEqual(action.items.map(({ name, amount }) => ({ name, amount })), [
        { name: 'Copper', amount: 10000 },
        { name: 'Machinery Parts', amount: 5000 },
        { name: 'Precision Parts', amount: 1000 },
    ]);
    assert.equal(BUILDING_UPKEEP[74].length, 15);
    assert.equal(BUILDING_UPKEEP[74].filter(({ name }) => name.startsWith('DNA -'))
        .every(({ amount }) => amount === 1), true);
    assert.deepEqual(BUILDING_UPKEEP[74].slice(-3).map(({ name, amount }) => ({ name, amount })), [
        { name: 'Gems', amount: 50 },
        { name: 'Tungsten', amount: 50 },
        { name: 'Copper', amount: 50 },
    ]);
});

test('caps Solar and Lunar Environmental Facilities at five owned', () => {
    assert.equal(ACTION_CATALOG[40].maxOwned, 5);
    assert.equal(ACTION_CATALOG[41].maxOwned, 5);

    const stats = {
        byName: {
            energy: { name: 'Energy', qty: 4, used: 0, mil: 0 },
            copper: { name: 'Copper', qty: 500, used: 0, mil: 0 },
            'machinery parts': { name: 'Machinery Parts', qty: 100, used: 0, mil: 0 },
            composites: { name: 'Composites', qty: 100, used: 0, mil: 0 },
        },
        buildingsByName: {
            'solar environmental facility': { qty: 4, active: 4 },
        },
    };
    const risks = projectActionRisks(ACTION_CATALOG[40], 5, stats, BUILDING_UPKEEP);
    assert.equal(risks.find(({ name }) => name === 'Energy').reserveAfter, 5,
        'only the one remaining facility is projected');
});

test('distinguishes verified, changed, and wholly unknown actions', () => {
    const expected = { name: 'Build Bakery', description: 'Uses apples every tick.' };
    assert.deepEqual(actionCompatibility({
        name: '  Build Bakery ', description: 'Uses   apples\n every tick.',
    }, expected), { status: 'verified', differences: [] });
    assert.deepEqual(actionCompatibility({
        name: 'Build Bakery', description: 'Now uses pies.',
    }, expected), { status: 'changed', differences: ['description'] });
    assert.equal(actionCompatibility({}, null).status, 'unknown');
});

test('warns when an immediate action cost dips below the existing reserve', () => {
    const action = {
        items: [{ name: 'Apples', isBuilding: false, consumed: true, amount: 3 }],
        output: null,
    };
    const risks = projectActionRisks(action, 1, {
        byName: { apples: { name: 'Apples', qty: 10, used: 8, mil: 0 } },
        buildingsByName: {},
    }, {});

    assert.deepEqual(risks, [{
        name: 'Apples', stockBefore: 10, stockAfter: 7, stockChange: -3,
        reserveBefore: 8, reserveAfter: 8, reserveChange: 0, shortage: 1,
    }]);
});

test('warns when new building upkeep exceeds stock left after construction', () => {
    const action = {
        items: [{ name: 'Energy', isBuilding: false, consumed: true, amount: 2 }],
        output: { resourceId: 99, name: 'Test Factory', isBuilding: true, amount: 1 },
    };
    const upkeep = { 99: [{ resourceId: 4, name: 'Energy', amount: 3 }] };
    const risks = projectActionRisks(action, 2, {
        byName: { energy: { name: 'Energy', qty: 9, used: 1, mil: 0 } },
        buildingsByName: {},
    }, upkeep);

    assert.equal(risks[0].stockAfter, 5);
    assert.equal(risks[0].reserveAfter, 7);
    assert.equal(risks[0].shortage, 2);
});

test('subtracts only the upkeep of active buildings consumed by an upgrade', () => {
    const action = {
        items: [{
            resourceId: 10, name: 'Old Factory', isBuilding: true, consumed: true, amount: 2,
        }],
        output: { resourceId: 11, name: 'New Factory', isBuilding: true, amount: 2 },
    };
    const upkeep = {
        10: [{ resourceId: 4, name: 'Energy', amount: 4 }],
        11: [{ resourceId: 4, name: 'Energy', amount: 5 }],
    };
    const risks = projectActionRisks(action, 1, {
        byName: { energy: { name: 'Energy', qty: 5, used: 4, mil: 0 } },
        buildingsByName: {
            'old factory': { name: 'Old Factory', qty: 3, disabled: 2, active: 1 },
        },
    }, upkeep);

    assert.equal(risks[0].reserveBefore, 4);
    assert.equal(risks[0].reserveAfter, 10, 'remove one active old upkeep, then add two new upkeep');
});

test('new DNA-facility upkeep is included in the safety projection', () => {
    const risks = projectActionRisks(ACTION_CATALOG[51], 1, {
        byName: {
            apples: { name: 'Apples', qty: 9, used: 0, mil: 0 },
            'machinery parts': { name: 'Machinery Parts', qty: 1000, used: 0, mil: 0 },
            'vehicle parts': { name: 'Vehicle Parts', qty: 750, used: 0, mil: 0 },
            'precision parts': { name: 'Precision Parts', qty: 500, used: 0, mil: 0 },
        },
        buildingsByName: {},
    }, BUILDING_UPKEEP);

    assert.deepEqual(risks, [{
        name: 'Apples', stockBefore: 9, stockAfter: 9, stockChange: 0,
        reserveBefore: 0, reserveAfter: 10, reserveChange: 10, shortage: 1,
    }]);
});

test('an owned-building limit caps the projected action count', () => {
    const action = {
        maxOwned: 1,
        items: [],
        output: { resourceId: 99, name: 'Unique Factory', isBuilding: true, amount: 1 },
    };
    const upkeep = { 99: [{ resourceId: 4, name: 'Energy', amount: 5 }] };
    const stats = {
        byName: { energy: { name: 'Energy', qty: 6, used: 0, mil: 0 } },
        buildingsByName: {},
    };
    assert.deepEqual(projectActionRisks(action, 10, stats, upkeep), []);

    stats.byName.energy.qty = 4;
    assert.equal(projectActionRisks(action, 10, stats, upkeep)[0].reserveAfter, 5,
        'project one remaining building, not all ten requested');

    stats.buildingsByName['unique factory'] = { qty: 1, active: 1 };
    assert.deepEqual(projectActionRisks(action, 10, stats, upkeep), []);
});

test('does not warn on an exact reserve boundary or unrelated existing shortage', () => {
    const exact = projectActionRisks({
        items: [{ name: 'Apples', isBuilding: false, consumed: true, amount: 2 }],
        output: null,
    }, 1, {
        byName: { apples: { name: 'Apples', qty: 10, used: 8, mil: 0 } },
        buildingsByName: {},
    }, {});
    assert.deepEqual(exact, []);

    const unrelated = projectActionRisks({ items: [], output: null }, 1, {
        byName: { apples: { name: 'Apples', qty: 1, used: 8, mil: 0 } },
        buildingsByName: {},
    }, {});
    assert.deepEqual(unrelated, []);
});

test('recognizes actions which can affect the protected reserve', () => {
    assert.equal(actionNeedsSafetyCheck({
        items: [{ consumed: true, isBuilding: false }], output: null,
    }, {}), true);
    assert.equal(actionNeedsSafetyCheck({
        items: [], output: { isBuilding: true, resourceId: 5 },
    }, { 5: [{ amount: 1 }] }), true);
    assert.equal(actionNeedsSafetyCheck({ items: [], output: null }, {}), false);
});

test('reads action multipliers using PHP-like numeric conversion', () => {
    assert.equal(phpInteger(' 12 '), 12);
    assert.equal(phpInteger('2.9'), 2);
    assert.equal(phpInteger('2foo'), 2);
    assert.equal(phpInteger('1e3'), 1000);
    assert.equal(phpInteger('not a number'), 0);
});

test('offers safe-action confirmation as a separate default-on setting', () => {
    const definitions = [];
    actionsModule.settings({ settings: { define: (definition) => definitions.push(definition) } });
    const setting = definitions.find(({ key }) => key === 'actions.confirmUpkeepRisk');
    assert.equal(setting.type, 'bool');
    assert.equal(setting.default, true);
    assert.equal(setting.section, 'Actions');
});
