import test from 'node:test';
import assert from 'node:assert/strict';

import {
    newlyCriticalOverviewBuffers, newlyCriticalResources, overviewResourceRows,
    overviewSatisfactionRow, publishResourceStats, readCachedResourceStats,
    RESOURCE_STATS_CACHE_KEY, resourceBufferSummary, resourceTicksWorth,
} from '../src/adapters/overview.js';
import { HEADER_PROBE_PAGE } from '../src/adapters/header.js';
import { satisfactionTicksWorth } from '../src/lib/satisfaction-safety.js';
import {
    isOverviewDestination, liveUpdatesModule, overviewMenuAnchors,
    resourceBufferTitleMarker,
} from '../src/ui/liveupdates.js';

test('recognises real Overview links without matching current-page controls', () => {
    const onOverview = 'https://clop.example/game/overview.php';
    const elsewhere = 'https://clop.example/game/reports.php';

    assert.equal(isOverviewDestination('overview.php', elsewhere), true);
    assert.equal(isOverviewDestination('/game/overview.php?view=full', elsewhere), true);
    assert.equal(isOverviewDestination('#', onOverview), false);
    assert.equal(isOverviewDestination('#settings', onOverview), false);
    assert.equal(isOverviewDestination('?sort=name', onOverview), false);
    assert.equal(isOverviewDestination('reports.php', onOverview), false);
});

test('targets both the Overview entry and its parent Nation menu', () => {
    const heading = { id: 'nation-heading' };
    const dropdown = {
        querySelector: (selector) => selector === ':scope > a.dropdown-toggle' ? heading : null,
    };
    const submenu = {
        closest: (selector) => selector === 'li.dropdown' ? dropdown : null,
    };
    const overview = {
        getAttribute: () => 'overview.php',
        closest: (selector) => selector === 'ul.dropdown-menu' ? submenu : null,
    };
    const currentPageControl = {
        getAttribute: () => '#',
        closest: () => null,
    };
    const doc = {
        querySelectorAll: () => [currentPageControl, overview],
    };

    assert.deepEqual(overviewMenuAnchors(
        doc, 'https://clop.example/game/overview.php'), [overview, heading]);
});

test('uses the highest Overview-buffer severity in the tab title', () => {
    assert.equal(resourceBufferTitleMarker({ warning: [], critical: [] }), '');
    assert.equal(resourceBufferTitleMarker({
        warning: [{ name: 'Cider', ticks: 5 }], critical: [],
    }), '!');
    assert.equal(resourceBufferTitleMarker({
        warning: [{ name: 'Cider', ticks: 5 }],
        critical: [{ name: 'Oil', ticks: 1 }],
    }), '!!');
    assert.equal(resourceBufferTitleMarker({
        warning: [], critical: [], warningCount: 1, criticalCount: 0,
    }), '!', 'a satisfaction-only warning is included');
    assert.equal(resourceBufferTitleMarker({
        warning: [], critical: [], warningCount: 0, criticalCount: 1,
    }), '!!', 'a satisfaction-only critical state is included');
});

test('counts the usable tick omitted by the stock Ticks-Worth column', () => {
    assert.equal(resourceTicksWorth({ qty: 5, used: 5, net: -5 }), 1);
    assert.equal(resourceTicksWorth({ qty: 15, used: 5, net: -5 }), 3);
    assert.equal(resourceTicksWorth({ qty: 100, used: 100, net: -10 }), 1,
        'mixed production and consumption retains the server formula');
    assert.equal(resourceTicksWorth({ qty: 99, used: 100, net: -10 }), 0);
    assert.equal(resourceTicksWorth({ qty: 5, used: 5, net: 0 }), null);
    assert.equal(resourceTicksWorth({ qty: 5, used: 5, net: 1 }), null);
});

test('splits low resource buffers at the configured inclusive thresholds', () => {
    const stats = {
        byName: {
            oil: { name: 'Oil', qty: 5, used: 5, net: -5 },
            cider: { name: 'Cider', qty: 25, used: 5, net: -5 },
            coffee: { name: 'Coffee', qty: 30, used: 5, net: -5 },
            energy: { name: 'Energy', qty: 1, used: 0, net: 2 },
        },
    };

    assert.deepEqual(resourceBufferSummary(stats, 5, 1), {
        warningThreshold: 5,
        criticalThreshold: 1,
        warning: [{ name: 'Cider', ticks: 5 }],
        critical: [{ name: 'Oil', ticks: 1 }],
        affected: [
            { name: 'Oil', ticks: 1 },
            { name: 'Cider', ticks: 5 },
        ],
        satisfaction: null,
        warningCount: 1,
        criticalCount: 1,
        affectedCount: 2,
    });
});

test('counts safe satisfaction ticks to the government rebel limit', () => {
    assert.equal(satisfactionTicksWorth({
        satisfaction: -95, satisfactionPerTick: -5, government: 'Loose Despotism',
    }), 1, 'landing exactly on -100 remains safe for one tick');
    assert.equal(satisfactionTicksWorth({
        satisfaction: -96, satisfactionPerTick: -5, government: 'Loose Despotism',
    }), 0, 'crossing the limit next tick is immediately critical');
    assert.equal(satisfactionTicksWorth({
        satisfaction: 0, satisfactionPerTick: -15, government: 'Loose Despotism',
    }), 6);
    assert.equal(satisfactionTicksWorth({
        satisfaction: -110, satisfactionPerTick: 10, government: 'Loose Despotism',
    }), null, 'recovery to exactly the limit avoids next-tick rebels');
    assert.equal(satisfactionTicksWorth({
        satisfaction: -110, satisfactionPerTick: 5, government: 'Loose Despotism',
    }), 0, 'partial recovery which remains below the limit is unsafe');
    assert.equal(satisfactionTicksWorth({
        satisfaction: -95, satisfactionPerTick: -5, government: 'Unknown Government',
    }), null);
});

test('folds satisfaction into the shared warning and critical counts', () => {
    const warning = resourceBufferSummary({
        byName: {},
        satisfaction: -75,
        satisfactionPerTick: -5,
        government: 'Loose Despotism',
    }, 5, 1);
    assert.equal(warning.satisfaction.severity, 'warning');
    assert.equal(warning.satisfaction.ticks, 5);
    assert.equal(warning.warningCount, 1);
    assert.equal(warning.affectedCount, 1);

    const critical = resourceBufferSummary({
        byName: {
            oil: { name: 'Oil', qty: 5, used: 5, net: -5 },
        },
        satisfaction: -95,
        satisfactionPerTick: -5,
        government: 'Loose Despotism',
    }, 5, 1);
    assert.equal(critical.satisfaction.severity, 'critical');
    assert.equal(critical.criticalCount, 2);
    assert.equal(critical.affectedCount, 2);
});

test('reports only resources which newly cross into critical status', () => {
    const before = {
        byName: {
            oil: { name: 'Oil', qty: 10, used: 5, net: -5 },
            cider: { name: 'Cider', qty: 5, used: 5, net: -5 },
        },
    };
    const after = {
        byName: {
            oil: { name: 'Oil', qty: 5, used: 5, net: -5 },
            cider: { name: 'Cider', qty: 0, used: 5, net: -5 },
            coffee: { name: 'Coffee', qty: 5, used: 5, net: -5 },
        },
    };

    assert.deepEqual(newlyCriticalResources(before, after, 5, 1), [
        { name: 'Coffee', ticks: 1 },
        { name: 'Oil', ticks: 1 },
    ]);
    assert.deepEqual(newlyCriticalResources(null, after, 5, 1), [],
        'the first sample establishes a silent notification baseline');
});

test('reports satisfaction newly crossing into critical status', () => {
    const before = {
        byName: {}, satisfaction: -90, satisfactionPerTick: -5,
        government: 'Loose Despotism',
    };
    const after = {
        byName: {}, satisfaction: -95, satisfactionPerTick: -5,
        government: 'Loose Despotism',
    };
    const changed = newlyCriticalOverviewBuffers(before, after, 5, 1);
    assert.deepEqual(changed.resources, []);
    assert.equal(changed.satisfaction.severity, 'critical');
    assert.equal(changed.satisfaction.ticks, 1);

    assert.deepEqual(newlyCriticalOverviewBuffers(null, after, 5, 1), {
        resources: [], satisfaction: null,
    });
});

test('publishes a compact Overview warning snapshot for other tabs', () => {
    const previousStorage = globalThis.localStorage;
    const values = new Map();
    const events = [];
    globalThis.localStorage = {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
    };
    try {
        const published = publishResourceStats({
            events: { emit: (type, value) => events.push({ type, value }) },
        }, {
            byName: {
                oil: {
                    name: 'Oil', qty: 12, generated: 0, used: 5, mil: 10, net: -5,
                },
            },
            satisfaction: 123,
            satisfactionPerTick: -7,
            government: 'Loose Despotism',
            buildingsByName: { refinery: { name: 'Refinery', qty: 1 } },
        }, 12345);

        assert.equal(values.has(RESOURCE_STATS_CACHE_KEY), true);
        assert.deepEqual(readCachedResourceStats(), published);
        assert.equal(published.satisfaction, 123);
        assert.equal(published.satisfactionPerTick, -7);
        assert.equal(published.government, 'Loose Despotism');
        assert.equal('buildingsByName' in published, false);
        assert.equal(events[0].type, 'overview:resourceStats');
        assert.deepEqual(events[0].value.stats, published);
    } finally {
        if (previousStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousStorage;
    }
});

test('finds Overview resource icon cells without hard-coded column positions', () => {
    const iconCell = { textContent: '' };
    const nameCell = { textContent: 'Oil' };
    const row = {
        querySelectorAll: () => [
            iconCell, nameCell, { textContent: '5' }, { textContent: '0' },
            { textContent: '5' }, { textContent: '0' }, { textContent: '-5' },
        ],
    };
    const table = {
        querySelectorAll(selector) {
            if (selector === 'thead td, thead th') {
                return ['', 'Resource', 'Qty', 'Generated', 'Used', 'Loss', 'Net']
                    .map((textContent) => ({ textContent }));
            }
            if (selector === 'tbody tr') return [row];
            return [];
        },
    };
    const panel = {
        querySelector(selector) {
            if (selector === '.panel-heading') return { textContent: 'Resources' };
            if (selector === 'table') return table;
            return null;
        },
    };

    assert.deepEqual(overviewResourceRows({ querySelectorAll: () => [panel] }), [{
        name: 'Oil', row, nameCell, iconCell,
    }]);
});

test('finds the Satisfaction label cell in the Overview Nation table', () => {
    const labelCell = { textContent: 'Satisfaction' };
    const valueCell = { textContent: '-95 (-5 per tick)' };
    const row = { querySelectorAll: () => [labelCell, valueCell] };
    const panel = {
        querySelector: (selector) => selector === '.panel-heading'
            ? { textContent: 'Nation' }
            : null,
        querySelectorAll: (selector) => selector === 'tbody tr' ? [row] : [],
    };

    assert.deepEqual(overviewSatisfactionRow({ querySelectorAll: () => [panel] }), {
        row, labelCell, valueCell,
    });
});

test('live updates expose resource thresholds and reuse Overview as their probe', () => {
    const definitions = [];
    liveUpdatesModule.settings({
        settings: { define: (definition) => definitions.push(definition) },
        events: { emit: () => {} },
    });

    const warning = definitions.find(({ key }) => key === 'overview.bufferWarningTicks');
    const critical = definitions.find(({ key }) => key === 'overview.bufferCriticalTicks');
    assert.equal(warning.default, 5);
    assert.equal(critical.default, 1);
    assert.equal(warning.min, 0);
    assert.equal(critical.step, 1);
    assert.equal(HEADER_PROBE_PAGE, 'overview.php');
});
