import test from 'node:test';
import assert from 'node:assert/strict';
import { armySizeFromDocument, equipmentRecipeFromForm, equipmentRecipeFromLines, forceTypesFromDocument } from '../src/adapters/military.js';
import { projectActionAffordability, projectActionRisks } from '../src/lib/action-safety.js';
import { armySatisfactionPenalty, nextWartick, projectForceCreation } from '../src/lib/military-safety.js';
import { actionWarningGroup, createActionSafetyDialogs } from '../src/ui/action-warning.js';
import { createEquipmentOptions } from '../src/ui/equipment-options.js';
import { militaryModule } from '../src/ui/military.js';
import { publishResourceStats, readCachedResourceStats } from '../src/adapters/overview.js';

const cavalry = { name: 'Cavalry', bitsCost: 200000, upkeep: { name: 'apples', amount: 5 } };
function stats(extra = {}) {
    return { funds: 1000000, satisfaction: 100, satisfactionPerTick: 2, government: 'Loose Despotism',
        seRelation: 1000, nlrRelation: -1000,
        byName: { apples: { name: 'Apples', qty: 30, generated: 10, used: 4, mil: 20, net: 6 } },
        ...extra };
}
function element(tag, attrs = {}, children = []) {
    return { tag, attrs, children, style: {},
        get textContent() { return children.map((child) => typeof child === 'object' ? child.textContent : child).join(''); },
        set textContent(value) { children = [value]; } };
}
const presentation = { el: element, commas: String, addStyle() {} };

test('military module is scoped to the three requested pages', () => {
    for (const page of ['createforces.php', 'makeequipment.php', 'equipforces.php']) assert.equal(militaryModule.matches(page), true);
    for (const page of ['groupforces.php', 'actions.php', 'overview.php']) assert.equal(militaryModule.matches(page), false);
});

test('equipment reads live line-item costs and fixed building prerequisites', () => {
    const action = equipmentRecipeFromLines('Build PRC-E6', 20000, ['20 Copper', '(Requires 1 Basic Factory)', '']);
    const current = { funds: 35000, byName: { copper: { name: 'Copper', qty: 35, used: 10 } }, buildingsByName: {} };
    const affordability = projectActionAffordability(action, 2, current);
    assert.deepEqual(affordability.map(({ name, required }) => [name, required]), [
        ['Basic Factory', 1], ['Bits', 40000], ['Copper', 40],
    ]);
    const [risk] = projectActionRisks(action, 2, current, {});
    assert.equal(risk.stockAfter, -5);
    assert.equal(risk.shortage, 15);
    assert.throws(() => equipmentRecipeFromLines('Unknown', 0, ['Also consumes oil.']), /Unrecognised/);
    assert.throws(() => equipmentRecipeFromLines('Unknown', 0, ['1,2 Copper']), /Unrecognised/);
});

test('equipment form adapter preserves BR boundaries and reads the live bits cost', () => {
    const paragraph = {
        querySelector: () => ({ textContent: 'Build PRC-E6' }),
        childNodes: [
            { nodeName: 'B', textContent: 'Build PRC-E6' }, { nodeName: 'BR' },
            { nodeName: '#text', textContent: '20 Copper' }, { nodeName: 'BR' },
            { nodeName: '#text', textContent: '(Requires 1 Basic Factory)' }, { nodeName: 'BR' },
        ],
    };
    const form = { closest: () => ({ querySelector: (selector) => selector === '.text-danger'
        ? { textContent: '25,000' } : paragraph }) };
    const action = equipmentRecipeFromForm(form);
    assert.equal(action.bitsCost, 25000);
    assert.equal(action.items.length, 2);
    assert.equal(action.items[1].isBuilding, true);
    assert.equal(action.items[1].consumed, false);
});

test('force type adapter reads changed prices and upkeep rather than hardcoding them', () => {
    const rows = [ ['Cavalry', '240,000', '6 apples/12 hours'], ['Alicorns', '2,000,000', '10 gems/12 hours'] ];
    const types = forceTypesFromDocument({ querySelectorAll: () => rows.map((cells) => ({
        querySelectorAll: () => cells.map((textContent) => ({ textContent })),
    })) });
    assert.deepEqual(types.get('Cavalry'), { name: 'Cavalry', bitsCost: 240000, upkeep: { name: 'apples', amount: 6 } });
    assert.equal(types.get('Alicorns').upkeep.amount, 10);
});

test('complete army parser deduplicates per-force forms and handles genuinely empty armies', () => {
    const doc = { querySelectorAll: () => [ ['1', 20], ['1', 20], ['2', 10] ].map(([value, size]) => ({
        value, closest: () => ({ textContent: `Away force Size: ${size} Training: 10` }),
    })) };
    assert.equal(armySizeFromDocument(doc), 30);
    assert.equal(armySizeFromDocument({ querySelectorAll: () => [], querySelector: () => ({ textContent: 'You have no forces to group!' }) }), 0);
    assert.throws(() => armySizeFromDocument({ querySelectorAll: () => [], querySelector: () => null }), /complete army/);
});

test('force creation checks bits, full wartick reserve, and averaged domestic production', () => {
    const result = projectForceCreation(cavalry, 6, '', 20, stats());
    assert.deepEqual(result.affordability, [{ name: 'Bits', required: 1200000, stock: 1000000, shortage: 200000 }]);
    assert.equal(result.risks[0].reserveBefore, 24);
    assert.equal(result.risks[0].reserveAfter, 54);
    assert.equal(result.risks[0].shortage, 24);
    assert.equal(result.resourceRateRisks.length, 1);
    assert.equal(result.resourceRateRisks[0].netBefore, 6 - 20 / 6);
    assert.equal(result.resourceRateRisks[0].netAfter, 6 - 20 / 6 - 30 / 6);
    assert.equal(result.satisfactionProjection.perTickChange, -3, 'satisfaction is NOT divided by six');
    assert.equal(result.satisfactionProjection.perTickAfter, -1);
    assert.equal(result.satisfactionProjection.trendRisk, true);
});

test('imported resources do not trigger domestic deficits; existing deficits still worsen', () => {
    const current = stats();
    current.byName.apples.generated = 0;
    assert.equal(projectForceCreation(cavalry, 6, '', 0, current).resourceRateRisks.length, 0);
    current.byName.apples.generated = 1;
    current.byName.apples.net = -3;
    assert.equal(projectForceCreation(cavalry, 1, '', 0, current).resourceRateRisks.length, 1);
    current.byName.apples.qty = 1000;
    assert.equal(projectForceCreation(cavalry, 1, '', 0, current).risks.length, 0);
});

test('mercenaries use the selected empire relationship, and alicorns use double gem upkeep', () => {
    const current = stats({ funds: 0 });
    assert.equal(projectForceCreation(cavalry, 1, 'se', 0, current).affordability[0].required, 400000);
    assert.equal(projectForceCreation(cavalry, 1, 'nlr', 0, current).affordability[0].required, 800000);
    assert.throws(() => projectForceCreation(cavalry, 1, 'se', 0, stats({ seRelation: null })), /relationship/);
    const alicorn = { name: 'Alicorns', bitsCost: 2000000, upkeep: { name: 'gems', amount: 10 } };
    const result = projectForceCreation(alicorn, 3, '', 0, current);
    assert.equal(result.risks[0].reserveAfter, 30);
    assert.equal(result.affordability[0].required, 6000000);
});

test('army satisfaction threshold, parity, rebel and collapse checks match normal action safety', () => {
    assert.deepEqual([0, 19, 20, 21, 22, 23].map(armySatisfactionPenalty), [0, 0, 0, 1, 1, 2]);
    assert.equal(projectForceCreation(cavalry, 1, '', 21, stats()).satisfactionProjection.perTickChange, 0);
    const rebel = projectForceCreation(cavalry, 4, '', 20, stats({ satisfaction: -99, satisfactionPerTick: 0 }));
    assert.equal(rebel.satisfactionProjection.hazard, 'rebels');
    assert.equal(rebel.satisfactionProjection.nextTickSatisfaction, -101);
    const collapse = projectForceCreation(cavalry, 4, '', 20, stats({ satisfaction: -4999, satisfactionPerTick: 0 }));
    assert.equal(collapse.satisfactionProjection.hazard, 'collapse');
    assert.throws(() => projectForceCreation(cavalry, Number.MAX_SAFE_INTEGER, '', 0, stats()), /safely/);
});

test('wartick timer uses UTC midnight/noon boundaries and formats HH:mm', () => {
    for (const [now, label, at] of [
        ['2026-09-11T01:15:30Z', '10:44', '2026-09-11T12:00:00Z'],
        ['2026-09-11T12:01:00Z', '11:59', '2026-09-12T00:00:00Z'],
        ['2026-09-11T23:59:30Z', '00:00', '2026-09-12T00:00:00Z'],
    ]) assert.deepEqual(nextWartick(Date.parse(now)), { at: Date.parse(at), label });
});

test('military warnings reuse the common sections and clearly label averaged rates and warticks', () => {
    const result = projectForceCreation(cavalry, 6, '', 20, stats());
    const group = actionWarningGroup(presentation, {
        ...result, satisfactionTrend: result.satisfactionProjection, wartick: { label: '03:15' },
    });
    assert.equal(group.attrs.class, 'alert alert-warning');
    assert.match(group.textContent, /averaged over 6 normal ticks/);
    assert.match(group.textContent, /Next wartick in 03:15/);
    assert.match(group.textContent, /short by 24 for next wartick/);
    assert.match(group.textContent, /Satisfaction declining/);
});

test('imminent resource-only military warnings use wartick time, sat hazards still use normal ticks', async () => {
    let options;
    const dialogs = createActionSafetyDialogs({ ...presentation, confirm: (opts) => { options = opts; return true; } });
    const wartick = { label: '03:00', at: Date.now() + 10800000 };
    const result = projectForceCreation(cavalry, 6, '', 0, stats());
    await dialogs.riskConfirmation({ name: 'Create Cavalry' }, 6, result.risks, null, { wartick });
    assert.equal(options.tickName, 'wartick');
    assert.ok(options.secondsUntilRisk() > 10790);
    await dialogs.riskConfirmation({ name: 'Create Cavalry' }, 6, result.risks,
        { hazard: 'rebels', nextTickSatisfaction: -101, satisfactionAfter: -99, perTickWithoutDecayAfter: -2 }, { wartick });
    assert.equal(options.tickName, 'tick');
    assert.equal(options.secondsUntilRisk, undefined);
});

function equipmentHarness() {
    const options = [ ['', 'Scrounged'], ['1', 'Current'], ['2', 'Enough (Have 10 extra)'], ['3', 'Short (Have 9 extra)'] ]
        .map(([value, textContent]) => ({ value, textContent, selected: value === '1', disabled: false }));
    const listeners = {};
    const button = { disabled: false, title: '' };
    const select = { name: 'weapon_id', value: '1', options, isConnected: true,
        form: { closest: () => ({ textContent: 'Cavalry Size: 10 Training: 5' }), querySelectorAll: () => [button] },
        addEventListener: (name, handler) => { listeners[name] = handler; } };
    const doc = { activeElement: null, querySelectorAll: () => [select] };
    const controller = createEquipmentOptions(doc);
    controller.bind();
    return { controller, doc, select, options, listeners, button };
}

test('equipment dropdowns disable short stock, retain current/scrounged, and defer updates while focused', () => {
    const h = equipmentHarness();
    assert.deepEqual(h.options.map((option) => option.disabled), [false, false, false, true]);
    assert.equal(h.options[3].textContent, 'Short (Have 9 extra)');
    h.doc.activeElement = h.select;
    h.controller.update({ at: 2, weaponsByName: { short: { qty: 100 } } });
    assert.equal(h.options[3].disabled, true, 'focused dropdown does not mutate');
    h.doc.activeElement = null;
    h.listeners.blur();
    assert.equal(h.options[3].disabled, false);
    assert.equal(h.options[2].disabled, true);
    h.controller.update({ at: 1, weaponsByName: {} });
    assert.equal(h.options[3].disabled, false, 'old snapshots cannot rewind stock');
    h.options[3].selected = true;
    h.options[1].selected = false;
    h.controller.update({ at: 3, weaponsByName: {} });
    assert.equal(h.options[3].disabled, true);
    assert.equal(h.button.disabled, true, 'unavailable selection must not submit as an unequip');
    assert.match(h.button.title, /Not enough spare equipment/);
    h.controller.update({ at: 3.5, weaponsByName: { short: { qty: 10 } } });
    assert.equal(h.options[3].disabled, false);
    assert.equal(h.button.disabled, false, 'replenished stock restores the selected option and button');
    h.controller.update({ at: 3.6, weaponsByName: {} });
    assert.equal(h.button.disabled, true);
    h.options[3].selected = false;
    h.options[0].selected = true;
    h.listeners.change();
    assert.equal(h.button.disabled, false, 'choosing Scrounged re-enables submission');
    h.controller.update({ at: 4, weaponsByName: { enough: { qty: null } } });
    assert.equal(h.options[2].disabled, false, 'unknown is not zero');
});

test('shared Overview cache carries equipment and distinguishes missing tables from empty stock', (t) => {
    const previous = globalThis.localStorage;
    let stored;
    globalThis.localStorage = { setItem: (key, value) => { stored = value; }, getItem: () => stored };
    t.after(() => { globalThis.localStorage = previous; });
    publishResourceStats(null, { ...stats(), weaponsByName: { prc: { name: 'PRC', qty: 12 } }, armorByName: {} });
    assert.deepEqual(readCachedResourceStats().weaponsByName, { prc: { name: 'PRC', qty: 12 } });
    assert.deepEqual(readCachedResourceStats().armorByName, {});
    publishResourceStats(null, stats());
    assert.equal(readCachedResourceStats().weaponsByName, null);
});
