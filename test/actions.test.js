import test from 'node:test';
import assert from 'node:assert/strict';

import { actionBitsCost, actionsFromDocument, phpInteger, submittedAction } from '../src/adapters/actions.js';
import {
    formatTickDuration, tickIsCritical, tickIsImminent,
    tickSecondsFromDocument, tickSecondsFromText,
} from '../src/adapters/header.js';
import {
    nationSatisfactionFromDocument, nationStatusFromDocument, parseResourceStats,
} from '../src/adapters/overview.js';
import {
    ACTION_CATALOG, BUILDING_EFFECTS, BUILDING_UPKEEP,
} from '../src/data/actions.generated.js';
import {
    actionCompatibility, actionNeedsSafetyCheck, projectActionAffordability, projectActionResourceRates,
    projectActionRisks, projectActionSatisfaction, SATISFACTION_SAFETY_MODES,
} from '../src/lib/action-safety.js';
import {
    actionsModule, burnOilOutcome, isDynamicFavouriteSubmission,
    SATISFACTION_SAFETY_MODE_SETTING_KEY,
} from '../src/ui/actions.js';

test('pairs original action mechanics with their original descriptions', () => {
    assert.equal(Object.keys(ACTION_CATALOG).length, 62);
    assert.equal(ACTION_CATALOG[5].name, 'Build Basic Factory');
    assert.match(ACTION_CATALOG[5].description, /Using 12 energy and 30 copper/);
    assert.deepEqual(ACTION_CATALOG[5].items.map(({ name, amount }) => ({ name, amount })), [
        { name: 'Energy', amount: 12 },
        { name: 'Copper', amount: 30 },
    ]);
    assert.deepEqual(BUILDING_UPKEEP[5], [{ resourceId: 4, name: 'Energy', amount: 1 }]);
    assert.equal(ACTION_CATALOG[4].satisfaction, -5);
    assert.deepEqual(BUILDING_EFFECTS[5], {
        resourceId: 5,
        name: 'Basic Factory',
        satisfaction: -1,
        badMin: 20,
        badDiv: 10,
        environmentalCleaner: false,
        production: [],
    });
    assert.deepEqual(BUILDING_EFFECTS[6].production, [
        { resourceId: 1, name: 'Oil', amount: 5 },
    ]);
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

test('does not add an upkeep warning to an unaffordable burn with zero oil upkeep', () => {
    const risks = projectActionRisks({
        items: [{ name: 'Oil', isBuilding: false, consumed: true, amount: 5 }],
        output: null,
    }, 1, {
        byName: { oil: { name: 'Oil', qty: 0, used: 0, mil: 0 } },
        buildingsByName: {},
    }, {});

    assert.deepEqual(risks, []);
});

test('lists all missing action materials while projecting upkeep on negative resulting stock', () => {
    const action = {
        items: [
            { name: 'Copper', amount: 25, consumed: true },
            { name: 'Machinery', amount: 10, consumed: true },
        ],
        output: null,
    };
    const stats = { byName: {
        copper: { name: 'Copper', qty: 35, used: 10 },
        machinery: { name: 'Machinery', qty: 12, used: 0 },
    } };
    assert.deepEqual(projectActionAffordability(action, 2, stats), [
        { name: 'Copper', required: 50, stock: 35, shortage: 15 },
        { name: 'Machinery', required: 20, stock: 12, shortage: 8 },
    ]);
    const risks = projectActionRisks(action, 2, stats, {});
    assert.equal(risks.length, 1);
    assert.equal(risks[0].stockAfter, -15);
    assert.equal(risks[0].shortage, 25);
});

test('affordability respects ownership limits and reusable prerequisites', () => {
    const action = {
        maxOwned: 5,
        items: [
            { name: 'Copper', amount: 50, consumed: true },
            { name: 'Factory', amount: 1, isBuilding: true, consumed: false },
        ],
        output: { name: 'Limited Building', amount: 1, isBuilding: true },
    };
    const stats = { byName: { copper: { qty: 50 } }, buildingsByName: {
        factory: { qty: 1, active: 0 }, 'limited building': { qty: 4 },
    } };
    assert.deepEqual(projectActionAffordability(action, 10, stats), []);
    delete stats.buildingsByName['limited building'];
    assert.deepEqual(projectActionAffordability(action, 10, stats), [
        { name: 'Copper', required: 250, stock: 50, shortage: 200 },
    ]);
    stats.buildingsByName['limited building'] = { qty: 5 };
    assert.deepEqual(projectActionAffordability(action, 10, stats), []);
});

test('action outputs cannot pay entry costs and absent known resources count as zero', () => {
    const action = {
        items: [{ name: 'Copper', amount: 50, consumed: true }],
        output: { name: 'Copper', amount: 100 },
    };
    assert.deepEqual(projectActionAffordability(action, 1, { byName: {} }), [
        { name: 'Copper', required: 50, stock: 0, shortage: 50 },
    ]);
    assert.deepEqual(projectActionAffordability(action, 1, null), []);
});

test('reads the live bits cost separately from numbers in the action description', () => {
    function formWithCost(cost) {
        const form = {
            closest: () => ({ childNodes: [
                { nodeType: 3, textContent: 'Costs 50 copper and originally cost 300,000 bits.' },
                { nodeType: 1, tagName: 'BR' },
                { nodeType: 1, tagName: 'SPAN', textContent: cost },
                { nodeType: 3, textContent: ' bits\n' },
                { nodeType: 1, tagName: 'BR' },
                form,
            ] }),
            querySelector: (selector) => selector === 'input[name="recipe_id"]' ? { value: '5' } : {},
            querySelectorAll: () => [{ name: '', value: 'Build Basic Factory' }],
        };
        return form;
    }
    const form = formWithCost(' 1,200,000 ');
    const actions = actionsFromDocument({ querySelectorAll: () => [form] });
    assert.equal(actions.get('5').bitsCost, 1200000);
    assert.match(actions.get('5').description, /300,000 bits/);
    assert.equal(actionBitsCost(formWithCost('0')), 0);
    assert.equal(actionBitsCost(formWithCost('-20,000')), -20000);
    assert.equal(actionBitsCost(formWithCost('unknown')), null);
    assert.equal(actionBitsCost(formWithCost('1,20,000')), null);
    assert.equal(actionBitsCost({ closest: () => null }), null);
});

test('checks bits-only actions and includes missing bits alongside missing materials', () => {
    const action = { items: [], output: null, bitsCost: 100000 };
    assert.equal(actionNeedsSafetyCheck(action, {}, {}), true);
    assert.deepEqual(projectActionAffordability(action, 3, { funds: 250000 }), [
        { name: 'Bits', required: 300000, stock: 250000, shortage: 50000 },
    ]);
    assert.deepEqual(projectActionRisks(action, 3, { funds: 250000 }, {}), [],
        'bits have no upkeep warning');
    assert.deepEqual(projectActionAffordability(action, 3, { funds: 300000 }), []);
    assert.deepEqual(projectActionAffordability(action, 1, { funds: null }), []);
    assert.deepEqual(projectActionAffordability(action, 1, {}), []);
    assert.deepEqual(projectActionAffordability({ ...action, bitsCost: -20000 }, 3, { funds: 0 }), []);
    assert.deepEqual(projectActionAffordability({ ...action, bitsCost: null }, 3, { funds: 0 }), []);

    action.items = [{ name: 'Copper', amount: 50, consumed: true }];
    assert.deepEqual(projectActionAffordability(action, 1, {
        funds: 90000, byName: { copper: { qty: 35 } },
    }), [
        { name: 'Bits', required: 100000, stock: 90000, shortage: 10000 },
        { name: 'Copper', required: 50, stock: 35, shortage: 15 },
    ]);
});

test('caps bits costs to the effective build count for limited buildings', () => {
    const action = {
        items: [], bitsCost: 100000, maxOwned: 5,
        output: { name: 'Limited Building', isBuilding: true, amount: 1 },
    };
    const stats = { funds: 90000, buildingsByName: { 'limited building': { qty: 4 } } };
    assert.deepEqual(projectActionAffordability(action, 100, stats), [
        { name: 'Bits', required: 100000, stock: 90000, shortage: 10000 },
    ]);
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

test('recognizes actions which need a safety projection', () => {
    assert.equal(actionNeedsSafetyCheck({
        items: [{ consumed: true, isBuilding: false }], output: null,
    }, {}, {}), true);
    assert.equal(actionNeedsSafetyCheck({
        items: [], output: { isBuilding: true, resourceId: 5 },
    }, { 5: [{ amount: 1 }] }, {}), true);
    assert.equal(actionNeedsSafetyCheck({
        items: [], output: { isBuilding: true, resourceId: 6 },
    }, {}, BUILDING_EFFECTS), true, 'a no-upkeep building still changes satisfaction');
    assert.equal(actionNeedsSafetyCheck({
        items: [], output: { isBuilding: true, resourceId: 78 },
    }, {}, BUILDING_EFFECTS), true, 'a production-only building still needs a rate projection');
    assert.equal(actionNeedsSafetyCheck({
        satisfaction: -5, items: [], output: null,
    }, {}, BUILDING_EFFECTS), true);
    assert.equal(actionNeedsSafetyCheck({ items: [], output: null }, {}, BUILDING_EFFECTS), false);
});

test('warns when building upkeep makes a domestically produced resource net-negative', () => {
    const action = {
        items: [],
        output: { resourceId: 99, name: 'Energy Consumer', isBuilding: true, amount: 1 },
    };
    const effects = {
        99: {
            resourceId: 99, name: 'Energy Consumer', satisfaction: 0,
            badMin: 0, badDiv: 0, environmentalCleaner: false, production: [],
        },
    };
    const risks = projectActionResourceRates(action, 1, {
        byName: {
            energy: { name: 'Energy', generated: 5, used: 3, net: 2 },
        },
        buildingsByName: {},
    }, {
        99: [{ resourceId: 4, name: 'Energy', amount: 4 }],
    }, effects);

    assert.deepEqual(risks, [{
        name: 'Energy',
        generatedBefore: 5,
        generatedAfter: 5,
        usedBefore: 3,
        usedAfter: 7,
        netBefore: 2,
        netAfter: -2,
        netChange: -4,
    }]);
});

test('warns when an action worsens an existing domestic resource deficit', () => {
    const action = {
        items: [],
        output: { resourceId: 99, name: 'Energy Consumer', isBuilding: true, amount: 1 },
    };
    const effects = {
        99: {
            resourceId: 99, name: 'Energy Consumer', satisfaction: 0,
            badMin: 0, badDiv: 0, environmentalCleaner: false, production: [],
        },
    };
    const [risk] = projectActionResourceRates(action, 1, {
        byName: {
            energy: { name: 'Energy', generated: 5, used: 6, net: -1 },
        },
        buildingsByName: {},
    }, {
        99: [{ resourceId: 4, name: 'Energy', amount: 2 }],
    }, effects);

    assert.equal(risk.netBefore, -1);
    assert.equal(risk.netAfter, -3);
});

test('does not warn about negative rates for purely imported resources', () => {
    const action = {
        items: [],
        output: { resourceId: 99, name: 'Oil Consumer', isBuilding: true, amount: 1 },
    };
    const effects = {
        99: {
            resourceId: 99, name: 'Oil Consumer', satisfaction: 0,
            badMin: 0, badDiv: 0, environmentalCleaner: false, production: [],
        },
    };
    const risks = projectActionResourceRates(action, 1, {
        byName: {
            oil: { name: 'Oil', generated: 0, used: 3, net: -3 },
        },
        buildingsByName: {},
    }, {
        99: [{ resourceId: 1, name: 'Oil', amount: 2 }],
    }, effects);

    assert.deepEqual(risks, []);
});

test('reads action multipliers using PHP-like numeric conversion', () => {
    assert.equal(phpInteger(' 12 '), 12);
    assert.equal(phpInteger('2.9'), 2);
    assert.equal(phpInteger('2foo'), 2);
    assert.equal(phpInteger('1e3'), 1000);
    assert.equal(phpInteger('not a number'), 0);
});

test('projects Burn Oil quantities and immediate satisfaction loss', () => {
    assert.deepEqual(burnOilOutcome(12, 50), {
        times: 12,
        oilBurned: 60,
        satisfactionBefore: 50,
        satisfactionLost: 60,
        satisfactionAfter: -10,
    });
    assert.equal(burnOilOutcome(10, 50).satisfactionAfter < 0, false,
        'landing exactly on zero does not meet the requested below-zero threshold');
    assert.equal(burnOilOutcome(0, 50), null);
});

test('catalogues the resource cost of the Max-enabled distribution actions', () => {
    assert.equal(ACTION_CATALOG[8].items[0].name, 'Apples');
    assert.equal(ACTION_CATALOG[8].items[0].amount, 5);
    assert.equal(ACTION_CATALOG[9].items[0].name, 'Pies');
    assert.equal(ACTION_CATALOG[9].items[0].amount, 1);
});

test('projects base and nonlinear environmental satisfaction from large builds', () => {
    const effects = {
        6: {
            resourceId: 6, name: 'Basic Oil Well', satisfaction: -2,
            badMin: 10, badDiv: 10, environmentalCleaner: false,
        },
    };
    const action = {
        satisfaction: 0,
        items: [],
        output: { resourceId: 6, name: 'Basic Oil Well', isBuilding: true, amount: 1 },
    };
    const projection = projectActionSatisfaction(action, 5, {
        satisfaction: 200,
        satisfactionPerTick: -20,
        government: 'Loose Despotism',
        buildingsByName: {
            'basic oil well': { name: 'Basic Oil Well', qty: 10, disabled: 0, active: 10 },
        },
    }, effects);

    assert.equal(projection.perTickChange, -13,
        'five wells add -10 base sat and three nonlinear environmental damage');
    assert.equal(projection.perTickAfter, -33);
    assert.equal(projection.trendRisk, true);
    assert.equal(projection.hazard, null);
    assert.equal(projection.environmentAfter.environmentalPenalty, 3);
});

test('evaluates satisfaction trends for either stable or max-at-cap play', () => {
    const effects = {
        99: {
            resourceId: 99, name: 'Test Building', satisfaction: -1,
            badMin: 0, badDiv: 0, environmentalCleaner: false,
        },
    };
    const action = {
        satisfaction: 0,
        items: [],
        output: { resourceId: 99, name: 'Test Building', isBuilding: true, amount: 1 },
    };
    const stats = {
        satisfaction: 421,
        satisfactionPerTick: -2,
        government: 'Loose Despotism',
        buildingsByName: {},
    };

    const stable = projectActionSatisfaction(action, 1, stats, effects);
    assert.equal(stable.currentDecay, 3);
    assert.equal(stable.perTickWithoutDecayBefore, 1);
    assert.equal(stable.perTickBefore, 1);
    assert.equal(stable.perTickAfter, 0);
    assert.equal(stable.trendRisk, false,
        'temporary high-satisfaction decay does not manufacture a structural deficit');

    const maximum = projectActionSatisfaction(
        action, 1, stats, effects, SATISFACTION_SAFETY_MODES.MAXIMUM);
    assert.equal(maximum.modeledDecay, 30);
    assert.equal(maximum.perTickBefore, -29);
    assert.equal(maximum.perTickAfter, -30);
    assert.equal(maximum.trendRisk, true);
});

test('always excludes high-satisfaction decay from immediate rebel projections', () => {
    const atLimit = projectActionSatisfaction(ACTION_CATALOG[4], 221, {
        satisfaction: 1000,
        satisfactionPerTick: -25,
        government: 'Loose Despotism',
        buildingsByName: {},
    }, BUILDING_EFFECTS, SATISFACTION_SAFETY_MODES.MAXIMUM);

    assert.equal(atLimit.currentDecay, 30);
    assert.equal(atLimit.perTickWithoutDecayAfter, 5);
    assert.equal(atLimit.satisfactionAfter, -105);
    assert.equal(atLimit.nextTickSatisfaction, -100);
    assert.equal(atLimit.hazard, null, 'landing exactly at the rebel limit remains safe');

    assert.equal(projectActionSatisfaction(ACTION_CATALOG[4], 222, {
        satisfaction: 1000,
        satisfactionPerTick: -25,
        government: 'Loose Despotism',
        buildingsByName: {},
    }, BUILDING_EFFECTS).hazard, 'rebels');
});

test('projects environmental cleaners against aggregate damage', () => {
    const effects = {
        6: {
            resourceId: 6, name: 'Basic Oil Well', satisfaction: -2,
            badMin: 10, badDiv: 10, environmentalCleaner: false,
        },
        44: {
            resourceId: 44, name: 'Solar Environmental Facility', satisfaction: 0,
            badMin: 0, badDiv: 0, environmentalCleaner: true,
        },
    };
    const projection = projectActionSatisfaction({
        satisfaction: 0,
        items: [],
        output: {
            resourceId: 44, name: 'Solar Environmental Facility', isBuilding: true, amount: 1,
        },
    }, 1, {
        satisfaction: 100,
        satisfactionPerTick: -50,
        government: 'Loose Despotism',
        buildingsByName: {
            'basic oil well': { name: 'Basic Oil Well', qty: 20, disabled: 0, active: 20 },
        },
    }, effects);

    assert.equal(projection.environmentBefore.environmentalPenalty, 10);
    assert.equal(projection.environmentAfter.environmentalPenalty, 9);
    assert.equal(projection.perTickChange, 1);
    assert.equal(projection.trendRisk, false, 'improving an existing decline is not warned');
});

test('classifies next-tick rebel and nation-collapse hazards', () => {
    const effects = {
        99: {
            resourceId: 99, name: 'Polluting Factory', satisfaction: -2,
            badMin: 0, badDiv: 0, environmentalCleaner: false,
        },
    };
    const action = {
        satisfaction: 0,
        items: [],
        output: { resourceId: 99, name: 'Polluting Factory', isBuilding: true, amount: 1 },
    };
    const stats = {
        satisfaction: -90,
        satisfactionPerTick: 0,
        government: 'Loose Despotism',
        buildingsByName: {},
    };

    assert.equal(projectActionSatisfaction(action, 5, stats, effects).hazard, null,
        'the exact -100 threshold does not create rebels');
    assert.equal(projectActionSatisfaction(action, 6, stats, effects).hazard, 'rebels');
    assert.equal(projectActionSatisfaction(action, 6, {
        ...stats, satisfaction: -4990,
    }, effects).hazard, 'collapse');
    assert.equal(projectActionSatisfaction({
        satisfaction: 0, items: [], output: null,
    }, 1, {
        ...stats, satisfaction: -110,
    }, effects).hazard, null, 'an unrelated action does not nag about an existing hazard');
});

test('uses the actual positive satisfaction rate before classifying Burn Oil', () => {
    const projection = projectActionSatisfaction(ACTION_CATALOG[4], 2, {
        satisfaction: -95,
        satisfactionPerTick: 10,
        government: 'Loose Despotism',
        buildingsByName: {},
    }, BUILDING_EFFECTS);

    assert.equal(projection.satisfactionAfter, -105);
    assert.equal(projection.nextTickSatisfaction, -95);
    assert.equal(projection.hazard, null);
    assert.equal(projection.trendRisk, false);
});

test('includes positive immediate and per-tick satisfaction from a building action', () => {
    const projection = projectActionSatisfaction(ACTION_CATALOG[13], 1, {
        satisfaction: -100,
        satisfactionPerTick: 0,
        government: 'Loose Despotism',
        buildingsByName: {},
    }, BUILDING_EFFECTS);

    assert.equal(projection.immediateChange, 2);
    assert.equal(projection.perTickChange, 1);
    assert.equal(projection.satisfactionAfter, -98);
    assert.equal(projection.nextTickSatisfaction, -97);
    assert.equal(projection.hazard, null);
});

test('reads funds, government and satisfaction rates from the Overview Nation panel', () => {
    const governmentRow = {
        querySelectorAll: () => [
            { textContent: 'Government Type' },
            { textContent: 'Loose Despotism' },
        ],
    };
    const satisfactionRow = {
        querySelectorAll: () => [
            { textContent: 'Satisfaction' },
            { textContent: '1,234 (-5 per tick)' },
        ],
    };
    const fundsCell = { textContent: '1,234,567 bits' };
    const fundsRow = { querySelectorAll: () => [{ textContent: 'Funds' }, fundsCell] };
    const panel = {
        querySelector: () => ({ textContent: 'Nation' }),
        querySelectorAll: () => [governmentRow, satisfactionRow, fundsRow],
    };
    const doc = {
        querySelectorAll: () => [panel],
    };
    assert.deepEqual(nationStatusFromDocument(doc), {
        funds: 1234567,
        government: 'Loose Despotism',
        satisfaction: 1234,
        satisfactionPerTick: -5,
    });
    assert.equal(nationSatisfactionFromDocument(doc), 1234);
    fundsCell.textContent = '0 bits';
    assert.equal(nationStatusFromDocument(doc).funds, 0);
    fundsCell.textContent = 'unknown bits';
    assert.equal(nationStatusFromDocument(doc).funds, null);
    assert.equal(nationStatusFromDocument({ querySelectorAll: () => [] }).funds, null);
});

test('reads domestic production from the Overview Resources table', () => {
    const cells = ['Energy', '100', '12', '9', '0', '+3'].map((textContent) => ({ textContent }));
    const table = {
        querySelectorAll(selector) {
            if (selector === 'thead td, thead th') {
                return ['Resource', 'Qty', 'Generated', 'Used', 'Loss', 'Net']
                    .map((textContent) => ({ textContent }));
            }
            if (selector === 'tbody tr') return [{ querySelectorAll: () => cells }];
            return [];
        },
    };
    const panel = {
        querySelector(selector) {
            if (selector === '.panel-heading') return { textContent: 'Resources' };
            if (selector === 'table') return table;
            return null;
        },
        querySelectorAll: () => [],
    };
    const stats = parseResourceStats({ querySelectorAll: () => [panel] });

    assert.deepEqual(stats.byName.energy, {
        name: 'Energy', qty: 100, generated: 12, used: 9, mil: 0, net: 3,
    });
});

test('enables safe actions on every page where recipes can be performed', () => {
    assert.equal(actionsModule.matches('actions.php'), true);
    assert.equal(actionsModule.matches('favoriteactions.php'), true);
    assert.equal(actionsModule.matches('overview.php'), true);
    assert.equal(actionsModule.matches('viewnation.php'), false);
});

test('defaults satisfaction safety to stable balance with a max-GDP alternative', () => {
    const definitions = [];
    actionsModule.settings({ settings: { define: (definition) => definitions.push(definition) } });
    const setting = definitions.find(({ key }) => key === SATISFACTION_SAFETY_MODE_SETTING_KEY);
    assert.equal(setting.default, SATISFACTION_SAFETY_MODES.STABLE);
    assert.deepEqual(setting.options.map(({ value }) => value), [
        SATISFACTION_SAFETY_MODES.STABLE,
        SATISFACTION_SAFETY_MODES.MAXIMUM,
    ]);
});

test('does not mistake embedded favourite-removal controls for performed actions', () => {
    const form = {
        querySelector(selector) {
            if (selector === 'input[name="recipe_id"]') return { value: '40' };
            if (selector === '[name="times"]') return { value: '3' };
            return null;
        },
    };

    assert.equal(submittedAction(form, { name: 'remove' }), null);
    assert.deepEqual(submittedAction(form, { name: 'perform' }), {
        id: '40', times: 3,
    });
});

test('makes perform and remove submissions dynamic only in Overview favourites', () => {
    const favouriteForm = {
        querySelector: (selector) => selector === 'input[name="token_favoriteactions"]'
            ? { value: 'token' }
            : null,
    };
    const ordinaryForm = { querySelector: () => null };

    assert.equal(isDynamicFavouriteSubmission(
        'overview.php', favouriteForm, { name: 'perform' }), true);
    assert.equal(isDynamicFavouriteSubmission(
        'overview.php', favouriteForm, { name: 'remove' }), true);
    assert.equal(isDynamicFavouriteSubmission(
        'overview.php', favouriteForm, null), true, 'Enter-key submission performs the action');
    assert.equal(isDynamicFavouriteSubmission(
        'favoriteactions.php', favouriteForm, { name: 'perform' }), false);
    assert.equal(isDynamicFavouriteSubmission(
        'overview.php', ordinaryForm, { name: 'perform' }), false);
});

test('reads the stock game tick countdown and applies a strict ten-minute threshold', () => {
    assert.equal(tickSecondsFromText('0:09:59'), 599);
    assert.equal(tickSecondsFromText('1:02:03'), 3723);
    assert.equal(tickSecondsFromText('NOW!'), 0);
    assert.equal(tickSecondsFromText('unknown'), null);
    assert.equal(tickSecondsFromDocument({
        querySelector: () => ({ textContent: ' 0:04:05 ' }),
    }), 245);
    assert.equal(tickIsImminent(599), true);
    assert.equal(tickIsImminent(600), false);
    assert.equal(tickIsImminent(null), false);
    assert.equal(tickIsCritical(91), false);
    assert.equal(tickIsCritical(90), true);
    assert.equal(tickIsCritical(0), true);
    assert.equal(formatTickDuration(599), '9m 59s');
});

test('offers safe-action confirmation and default-on trend settings', () => {
    const definitions = [];
    actionsModule.settings({ settings: { define: (definition) => definitions.push(definition) } });
    const setting = definitions.find(({ key }) => key === 'actions.confirmUpkeepRisk');
    assert.equal(setting.label, 'Confirm risky actions');
    assert.equal(setting.type, 'bool');
    assert.equal(setting.default, true);
    assert.equal(setting.section, 'Actions');

    for (const key of [
        'actions.confirmNegativeSatisfactionRate',
        'actions.confirmNegativeResourceRates',
    ]) {
        const trendSetting = definitions.find((definition) => definition.key === key);
        assert.equal(trendSetting.type, 'bool');
        assert.equal(trendSetting.default, true);
        assert.equal(trendSetting.parent, 'actions.confirmUpkeepRisk');
        assert.equal(trendSetting.section, 'Actions');
    }
});
