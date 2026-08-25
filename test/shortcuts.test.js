import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    dismissShortcutOnboarding, marketShortcutTarget, newShortcut,
    pageShortcutTarget, readShortcuts, shortcutHref, shortcutIdentity,
    shortcutOnboardingDismissed, shortcutStorageChange, writeShortcuts,
} from '../src/lib/shortcuts.js';

const previousStorage = globalThis.localStorage;
const values = new Map();
const origin = 'https://4clop.org';

globalThis.localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
};

beforeEach(() => values.clear());
after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
});

test('canonicalises same-origin page targets and rejects external destinations', () => {
    assert.deepEqual(pageShortcutTarget('reports.php?b=2&a=1#latest', origin), {
        kind: 'page', href: '/reports.php?a=1&b=2#latest',
    });
    assert.equal(pageShortcutTarget('https://example.com/reports.php', origin), null);
    assert.equal(pageShortcutTarget('javascript:alert(1)', origin), null);
});

test('gives a specific marketplace view a stable identity and real deep link', () => {
    const target = marketShortcutTarget('buyer', 'weapons', 42, 'Rifles');

    assert.deepEqual(target, {
        kind: 'market', side: 'buyer', mode: 'weapons',
        resourceId: '42', resourceName: 'Rifles',
    });
    assert.equal(shortcutIdentity(target), 'market:buyer:weapons:42');
    assert.equal(shortcutHref(target), 'buyermarketplace.php?mode=weapons#clopx-market=42');
    assert.equal(marketShortcutTarget('unknown', '', '42'), null);
});

test('preserves shortcut order while rejecting duplicate and malformed records', () => {
    const reports = newShortcut('Reports', pageShortcutTarget('/reports.php', origin), 'reports');
    const alliance = newShortcut('Alliance Six', pageShortcutTarget('/viewalliance.php?alliance_id=6', origin), 'alliance');
    const duplicate = { ...reports, id: 'duplicate', label: 'Reports again' };

    writeShortcuts([alliance, reports, duplicate, { id: 'broken', target: { kind: 'nope' } }], origin);

    assert.deepEqual(readShortcuts(origin), [alliance, reports]);
});

test('tracks onboarding independently from the shortcut list', () => {
    assert.equal(shortcutOnboardingDismissed(), false);
    dismissShortcutOnboarding();
    assert.equal(shortcutOnboardingDismissed(), true);
    assert.equal(shortcutStorageChange('clopx.shortcuts.items'), 'items');
    assert.equal(shortcutStorageChange('clopx.shortcuts.onboardingDismissed'), 'onboarding');
    assert.equal(shortcutStorageChange('clopx.market.favs.sell.resources'), null);
});
