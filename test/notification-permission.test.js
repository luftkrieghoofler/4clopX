import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationPermissionNotice } from '../src/ui/notification-permission.js';
import { liveUpdatesModule } from '../src/ui/liveupdates.js';

test('notification controls live in General with a mobile caveat; polling controls stay in Live updates', () => {
    const definitions = new Map();
    liveUpdatesModule.settings({ settings: { define: def => definitions.set(def.key, def) } });
    assert.equal(definitions.get('live.notify').section, 'General');
    assert.equal(definitions.get('live.testNotification').section, 'General');
    assert.match(definitions.get('live.notify').description, /On mobile, notifications can be unreliable/);
    for (const key of ['live.enabled', 'live.intervalFocused', 'live.intervalBlurred', 'live.status']) {
        assert.equal(definitions.get(key).section, 'Live updates');
    }
});

class Node {
    constructor(attrs = {}, children = []) {
        Object.assign(this, attrs);
        this.children = children;
        this.parentNode = null;
        this.classes = new Set((attrs.class || '').split(' '));
        this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    }
    appendChild(node) { node.remove(); this.children.push(node); node.parentNode = this; }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
        this.parentNode = null;
    }
}

function harness(state = 'default', { enabled = true, queryFails = false } = {}) {
    const listeners = new Map();
    const on = (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
    };
    const emit = (name, event = {}) => { for (const fn of listeners.get(name) || []) fn(event); };
    const nodes = [], body = new Node(), host = new Node();
    let asked = 0, signals = 0, pendingResolve;
    const api = state === 'unavailable' ? null : {
        permission: state,
        requestPermission() { asked++; return new Promise(resolve => { pendingResolve = resolve; }); },
    };
    const core = {
        addStyle() {},
        el: (tag, attrs, children) => { const node = new Node(attrs, children); nodes.push(node); return node; },
        events: { on, emit },
        settings: { get: () => enabled, set: (key, value) => { enabled = value; emit('settings:changed', { key }); } },
    };
    const notice = createNotificationPermissionNotice(core, {
        doc: { body, addEventListener: (name, fn) => on(`doc:${name}`, fn) },
        win: { addEventListener: (name, fn) => on(`win:${name}`, fn) },
        notification: () => api, signal: () => signals++,
        permissions: { query: () => queryFails ? Promise.reject(new Error('Unsupported'))
            : Promise.resolve({ addEventListener: (name, fn) => on(`permission:${name}`, fn) }) },
    });
    const card = nodes.find(node => node.classes.has('clop-notification-permission'));
    const [heading, explanation, feedback, help, actions] = card.children;
    const [grant, disable] = actions.children;
    return { notice, core, body, host, api, card, heading, explanation, feedback, help, grant, disable,
        emit, asked: () => asked, signals: () => signals,
        resolve(permission) { api.permission = permission; pendingResolve(permission); },
    };
}

test('first use shows a corner card, not an automatic permission request', () => {
    const h = harness();
    assert.equal(h.asked(), 0);
    assert.equal(h.card.parentNode, h.body);
    assert.equal(h.card.classes.has('clop-notification-permission-floating'), true);
    assert.equal(h.grant.textContent, 'Grant browser permission');
    h.emit('doc:click');
    assert.equal(h.asked(), 0);
    h.disable.onclick();
    assert.equal(h.core.settings.get('live.notify'), false);
    assert.equal(h.card.parentNode, null);
});

test('one card moves inline and returns when settings closes', () => {
    const h = harness();
    h.emit('settings:visibility', { open: true });
    assert.equal(h.card.parentNode, null);
    const cleanup = h.notice.mount(h.host);
    assert.equal(h.card.parentNode, h.host);
    assert.equal(h.body.children.length, 0);
    assert.equal(h.card.classes.has('clop-notification-permission-floating'), false);
    cleanup();
    assert.equal(h.card.parentNode, null);
    h.emit('settings:visibility', { open: false });
    assert.equal(h.card.parentNode, h.body);
});

test('grant starts in the click handler, deduplicates, and removes the card on success', async () => {
    const h = harness();
    h.grant.onclick();
    assert.equal(h.asked(), 1);
    const completion = h.notice.request();
    assert.equal(h.asked(), 1);
    assert.equal(h.grant.disabled, true);
    h.resolve('granted');
    await completion;
    assert.equal(h.card.parentNode, null);
    assert.equal(h.signals(), 1);
});

test('dismissal leaves retry available without calling it blocked or prompting again', async () => {
    const h = harness();
    const completion = h.notice.request();
    h.resolve('default');
    await assert.rejects(completion, /wasn’t granted/);
    assert.equal(h.card.parentNode, h.body);
    assert.equal(h.grant.textContent, 'Grant browser permission');
    assert.equal(h.grant.disabled, false);
    assert.equal(h.feedback.hidden, false);
    assert.doesNotMatch(h.feedback.textContent, /blocked/);
    h.emit('win:focus');
    assert.equal(h.asked(), 1);
});

test('blocked permission offers instructions; browser permission changes refresh the card', async () => {
    const h = harness('denied');
    assert.equal(h.grant.textContent, 'How to allow');
    assert.match(h.explanation.textContent, /blocked/);
    h.grant.onclick();
    assert.equal(h.help.hidden, false);
    assert.equal(h.asked(), 0);
    await Promise.resolve();
    h.api.permission = 'granted';
    h.emit('permission:change');
    assert.equal(h.card.parentNode, null);
    h.api.permission = 'denied';
    h.emit('permission:change');
    assert.equal(h.card.parentNode, h.body);
});

test('unavailable browsers offer disable; granted or disabled needs no card', () => {
    const h = harness('unavailable');
    assert.equal(h.card.parentNode, h.body);
    assert.equal(h.grant.hidden, true);
    assert.match(h.explanation.textContent, /does not expose/);
    assert.equal(harness('granted').card.parentNode, null);
    assert.equal(harness('default', { enabled: false }).card.parentNode, null);
});

test('settings and cross-tab signals refresh without Permissions API support', async () => {
    const h = harness('default', { queryFails: true });
    await Promise.resolve();
    h.core.settings.set('live.notify', false);
    assert.equal(h.card.parentNode, null);
    h.core.settings.set('live.notify', true);
    assert.equal(h.card.parentNode, h.body);
    assert.equal(h.asked(), 0);
    h.api.permission = 'granted';
    h.emit('win:storage', { key: 'clopx.notificationPermissionChanged' });
    assert.equal(h.card.parentNode, null);
    h.api.permission = 'default';
    h.emit('win:focus');
    assert.equal(h.card.parentNode, h.body);
});

test('the setting prompts immediately only for local enabling, and uses the shared notice', async t => {
    const h = harness();
    const definitions = new Map();
    h.core.settings.define = def => definitions.set(def.key, def);
    h.core.notificationPermission = h.notice;
    liveUpdatesModule.settings(h.core);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: h.api });
    t.after(() => previous ? Object.defineProperty(globalThis, 'Notification', previous) : delete globalThis.Notification);
    const setting = definitions.get('live.notify');
    setting.onChange(true, { source: 'remote' });
    setting.onChange(false, { source: 'local' });
    assert.equal(h.asked(), 0);
    h.emit('settings:visibility', { open: true });
    const cleanup = setting.mount(h.host);
    setting.onChange(true, { source: 'local' });
    assert.equal(h.asked(), 1);
    assert.equal(h.card.parentNode, h.host);
    const completion = h.notice.request();
    h.resolve('granted');
    await completion;
    assert.equal(h.card.parentNode, null);
    cleanup();
});
