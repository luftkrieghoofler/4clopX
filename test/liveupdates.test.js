import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTab, LIVE_LEADER_TTL } from '../src/lib/live-tab.js';
import { deliverNotification, requestNotificationPermission } from '../src/lib/desktop-notifications.js';
import { liveUpdatesModule } from '../src/ui/liveupdates.js';
import { marketAdapter } from '../src/adapters/market.js';

function tabs() {
    const store = new Map();
    let time = 100000;
    function add(id) {
        let focused = false;
        return {
            ...createLiveTab({ id, read: key => store.get(key),
                write: (key, value) => store.set(key, value), remove: key => store.delete(key),
                focused: () => focused, now: () => time }),
            focus(value) { focused = value; this.stampFocus(); },
        };
    }
    return { store, add, advance: ms => { time += ms; } };
}

test('minute-batched heartbeats do not spuriously replace the background leader', () => {
    const h = tabs(), a = h.add('a'), b = h.add('b');
    assert.equal(a.maintain(), true);
    for (let i = 0; i < 10; i++) {
        h.advance(60000);
        assert.equal(b.maintain(), false);
        assert.equal(a.maintain(), true);
    }
    h.advance(LIVE_LEADER_TTL);
    assert.equal(b.maintain(), true);
    assert.equal(a.isLeader(), false);
    assert.equal(a.maintain(), false);
});

test('focused tabs can take over without waiting for a background timer', () => {
    const h = tabs(), a = h.add('a'), b = h.add('b');
    a.maintain();
    b.focus(true);
    assert.equal(b.maintain(), true);
    assert.equal(a.maintain(), false);
    // Releasing a superseded tab must not remove another tab's records.
    a.release();
    assert.equal(b.isLeader(), true);
    assert.equal(a.anyoneFocused(), true);
    b.focus(false);
    b.maintain();
    a.focus(true);
    assert.equal(a.maintain(), true);
});

test('blur clears suppression immediately, and stale focus records expire', () => {
    const h = tabs(), a = h.add('a'), b = h.add('b');
    a.focus(true);
    assert.equal(b.anyoneFocused(), true);
    a.focus(false);
    assert.equal(b.anyoneFocused(), false);
    a.focus(true);
    b.focus(true);
    a.focus(false); // late blur must not erase b's newer focus
    assert.equal(a.anyoneFocused(), true);
    h.advance(26000);
    assert.equal(a.anyoneFocused(), false);
    b.stampFocus();
    assert.equal(a.anyoneFocused(), true);
    b.release();
    assert.equal(a.anyoneFocused(), false);
});

test('permission requests report denied/unsupported browsers and avoid repeat prompts', async () => {
    await assert.rejects(requestNotificationPermission(null), /does not expose/);
    await assert.rejects(requestNotificationPermission({ permission: 'denied' }), /blocked/);
    let prompts = 0;
    const api = { permission: 'default', requestPermission: async () => { prompts++; return 'granted'; } };
    await requestNotificationPermission(api);
    api.permission = 'granted';
    await requestNotificationPermission(api);
    assert.equal(prompts, 1);
});

test('notification delivery records synchronous and asynchronous failures, not false success', () => {
    const results = [], warnings = [], clicks = [];
    let instance;
    class Notifications {
        static permission = 'granted';
        constructor(title, options) { instance = this; this.title = title; this.options = options; }
    }
    const options = { body: 'News', href: 'messages.php', tag: 'messages',
        NotificationAPI: Notifications, now: () => 123,
        record: result => results.push(result), warn: (...args) => warnings.push(args),
        onClick: (notification, href) => clicks.push(href) };
    assert.equal(deliverNotification(options), true);
    assert.equal(results.at(-1).state, 'requested');
    assert.match(results.at(-1).detail, /not guaranteed/);
    assert.equal(instance.options.tag, 'clopx-messages');
    instance.onclick();
    assert.deepEqual(clicks, ['messages.php']);
    instance.onerror();
    assert.equal(results.at(-1).state, 'failed');
    class Broken extends Notifications { constructor() { throw new Error('Platform rejected it'); } }
    assert.equal(deliverNotification({ ...options, NotificationAPI: Broken }), false);
    assert.equal(results.at(-1).detail, 'Platform rejected it');
    Notifications.permission = 'denied';
    assert.equal(deliverNotification(options), false);
    assert.equal(warnings.length, 3);
});

// Exercise the real module's scheduler and lifecycle listeners without a game
// DOM. HTTP remains pending so tests can transfer ownership during a request.
function moduleHarness(t) {
    let time = 1000000, focused = false, nextJob = 0;
    const store = new Map(), timeouts = new Map(), intervals = [], handlers = new Map();
    const requests = [], emitted = [];
    const addEventListener = (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(fn);
    };
    const node = () => ({ style: { setProperty() {} }, classList: { toggle() {} },
        appendChild() {}, remove() {}, querySelector: () => null });
    const doc = { hidden: true, hasFocus: () => focused, title: 'CLOP',
        body: node(), documentElement: node(), addEventListener,
        querySelector: selector => selector === 'a[href="logout.php"]' ? {} : null,
        querySelectorAll: () => [] };
    const values = new Map(), definitions = new Map();
    const core = {
        el: (tag, attrs = {}, children = []) => ({ ...node(), ...attrs, children,
            querySelector: selector => selector === 'a' ? children[0] : null }),
        addStyle() {}, commas: String,
        settings: { define: def => { definitions.set(def.key, def); values.set(def.key, def.default); }, get: key => values.get(key) },
        events: { on: addEventListener, emit: (name, value) => emitted.push([name, value]) },
        http: { getDoc: () => new Promise(resolve => requests.push(resolve)) },
        confirm: async options => options,
    };
    const globals = { document: doc, location: { pathname: '/reports.php', href: 'https://4clop.org/reports.php' },
        window: { addEventListener, getComputedStyle: () => ({ backgroundColor: '#999' }) },
        localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
        setTimeout: (fn, ms) => { timeouts.set(++nextJob, { fn, ms }); return nextJob; },
        clearTimeout: id => timeouts.delete(id), setInterval: fn => intervals.push(fn),
    };
    for (const [key, value] of Object.entries(globals)) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
    }
    t.mock.method(Date, 'now', () => time);
    liveUpdatesModule.settings(core);
    liveUpdatesModule.init(core);
    return { core, store, requests, emitted, timeouts, doc, values, definitions,
        advance: ms => { time += ms; },
        event: name => { for (const fn of handlers.get(name) || []) fn(); },
        focus(value) { focused = value; doc.hidden = !value; },
    };
}

test('resume performs one overdue poll, not a catch-up burst or another delayed timer', async t => {
    const h = moduleHarness(t);
    assert.equal(h.timeouts.size, 1);
    h.advance(20 * 60000);
    h.focus(true);
    h.event('focus');
    assert.equal(h.requests.length, 1);
    h.event('pageshow');
    h.event('online');
    h.event('resume');
    assert.equal(h.requests.length, 1);
    h.event('blur');
});

test('superseded in-flight polls do not publish results or reschedule', async t => {
    const h = moduleHarness(t);
    h.advance(60001);
    h.event('resume');
    assert.equal(h.requests.length, 1);
    const before = h.store.get('clopx.live.badges');
    h.store.set('clopx.live.leader', JSON.stringify({ id: 'another', at: Date.now(), focused: true }));
    h.requests[0](h.doc);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.store.get('clopx.live.badges'), before);
    assert.equal(h.store.has('clopx.live.success'), false);
    assert.equal(h.timeouts.size, 0);
});

test('freeze releases ownership; pageshow resumes an overdue schedule without waiting', t => {
    const h = moduleHarness(t);
    h.event('freeze');
    assert.equal(h.store.has('clopx.live.leader'), false);
    assert.equal(h.timeouts.size, 0);
    h.advance(60001);
    h.event('pageshow');
    assert.equal(h.requests.length, 1);
});

test('a stale queued timer rechecks ownership before fetching', t => {
    const h = moduleHarness(t);
    const delayed = [...h.timeouts.values()][0].fn;
    h.store.set('clopx.live.leader', JSON.stringify({ id: 'another', at: Date.now(), focused: true }));
    delayed();
    assert.equal(h.requests.length, 0);
});

test('status distinguishes partial failures from a fully successful poll', async t => {
    const h = moduleHarness(t);
    t.mock.method(console, 'warn', () => {});
    h.advance(60001);
    h.event('resume');
    h.requests[0](h.doc); // logged in, but Resources table is missing
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.store.has('clopx.live.success'), false);
    assert.match(JSON.parse(h.store.get('clopx.live.error')).detail, /Resources table/);
    // Supply a valid (empty) Resources table on the next poll.
    const table = { querySelectorAll: selector => selector === 'thead td, thead th'
        ? ['Resource', 'Qty', 'Generated', 'Used', 'Net'].map(textContent => ({ textContent })) : [] };
    const panel = { querySelector: selector => selector === '.panel-heading'
        ? { textContent: 'Resources' } : selector === 'table' ? table : null,
        querySelectorAll: () => [] };
    const response = { ...h.doc, querySelectorAll: selector => selector === '.panel' ? [panel] : [] };
    h.advance(60001);
    h.event('resume');
    h.requests[1](response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(h.store.get('clopx.live.success')), Date.now());
    assert.equal(JSON.parse(h.store.get('clopx.live.error')), null);
    const status = await h.core.liveUpdates.showStatus();
    assert.match(status.body.map(row => row.children.join('')).join('\n'), /Last successful full check:/);
});

test('test notification bypasses focus and the automatic-notification preference', async t => {
    const h = moduleHarness(t);
    h.focus(true);
    h.event('focus');
    h.values.set('live.notify', false);
    let sent = 0;
    class Notifications {
        static permission = 'granted';
        constructor() { sent++; }
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Notifications });
    t.after(() => previous ? Object.defineProperty(globalThis, 'Notification', previous) : delete globalThis.Notification);
    await h.definitions.get('live.testNotification').handler();
    assert.equal(sent, 1);
    assert.equal(JSON.parse(h.store.get('clopx.live.notification')).state, 'requested');
});

test('market notification toggle leaves polling/cache active and respects the global toggle', async t => {
    const h = moduleHarness(t);
    const setting = h.definitions.get('market.desktopNotifications');
    assert.equal(setting.section, 'Market');
    assert.equal(setting.default, true);
    t.mock.method(console, 'warn', () => {}); // This minimal Overview has no Resources table.
    let sent = 0, loads = 0, amount = 10;
    class Notifications {
        static permission = 'granted';
        constructor() { sent++; }
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: Notifications });
    t.after(() => previous ? Object.defineProperty(globalThis, 'Notification', previous) : delete globalThis.Notification);
    h.store.set('clopx.market.favs.sell.resources', JSON.stringify([{ id: '1', name: 'Apples' }]));
    h.store.set('clopx.market.notify', JSON.stringify({ 'resources|sell|1': true }));
    h.store.set('clopx.live.friendly', JSON.stringify({ 'resources|sell|1': { count: 0, amount: 0 } }));
    t.mock.method(marketAdapter(h.core, 'sell', ''), 'load', async () => {
        loads++;
        return { resources: [{ id: '1', name: 'Apples' }], orders: [{ relation: 'alliance', amount }] };
    });
    async function poll() {
        h.advance(60001);
        h.event('resume');
        h.requests.at(-1)(h.doc);
        await new Promise(resolve => setImmediate(resolve));
    }
    h.values.set('market.desktopNotifications', false);
    await poll();
    assert.equal(loads, 1);
    assert.equal(sent, 0);
    assert.equal(JSON.parse(h.store.get('clopx.live.friendly'))['resources|sell|1'].amount, 10);
    assert.ok(h.emitted.some(([name]) => name === 'market:friendlyCache'));
    h.values.set('market.desktopNotifications', true);
    await poll();
    assert.equal(sent, 0, 'enabling does not replay orders already observed while muted');
    amount = 20;
    await poll();
    assert.equal(sent, 1);
    h.values.set('live.notify', false);
    amount = 30;
    await poll();
    assert.equal(sent, 1, 'the global switch still suppresses delivery');
    assert.equal(loads, 4);
});
