import test from 'node:test';
import assert from 'node:assert/strict';
import { militaryModule } from '../src/ui/military.js';

function harness(t, page, { safety = false, funds = 1000000 } = {}) {
    const old = Object.fromEntries(['document', 'window', 'location'].map((key) => [key, globalThis[key]]));
    t.after(() => Object.assign(globalThis, old));
    t.mock.method(globalThis, 'FormData', function (form) { return new URLSearchParams(form.fields); });
    const posts = [], gets = [], messages = [], confirmations = [];
    const events = new Map();
    const settings = { 'actions.confirmUpkeepRisk': safety, 'actions.confirmNegativeResourceRates': true,
        'actions.confirmNegativeSatisfactionRate': true, 'actions.satisfactionSafetyMode': 'stable' };
    let forms = [], allow = true, replacement = 0;
    function makeForm(token = 'old-token') {
        const fields = page === 'createforces.php'
            ? { token_createforces: token, forcetype: '1', size: '6', name: 'My Cavalry', mercenaries: '' }
            : page === 'makeequipment.php'
                ? { token_makeweapons: token, mode: 'weapons', weaponrecipe_id: '1', times: '1' }
                : { token_equipforces: token, force_id: '4', weapon_id: '2' };
        const listeners = {};
        const inputs = Object.fromEntries(Object.keys(fields).map((name) => [name, {
            name, get value() { return fields[name]; }, set value(value) { fields[name] = value; },
            type: ['times', 'name', 'size'].includes(name) ? 'text' : 'hidden',
            options: name === 'forcetype' ? [{ value: '1', textContent: 'Cavalry' }] : undefined,
        }]));
        const button = { name: page === 'createforces.php' ? 'createforce' : page === 'equipforces.php' ? 'changeweapon' : '', value: 'Perform' };
        const paragraph = { querySelector: () => ({ textContent: 'Build PRC-E6' }),
            childNodes: [{ nodeName: 'B', textContent: 'Build PRC-E6' }, { nodeName: 'BR' }, { textContent: '20 Copper' }, { nodeName: 'BR' }] };
        const row = { querySelector: (selector) => selector === '.text-danger' ? { textContent: '20,000' } : paragraph };
        const form = { fields, inputs, button, listeners,
            classList: { add() {}, remove() {} },
            closest: () => row,
            addEventListener: (name, handler) => { assert.equal(listeners[name], undefined); listeners[name] = handler; },
            querySelector: (selector) => {
                if (selector === 'input[type="submit"]') return button;
                const name = selector.match(/name="([^"]+)"/)?.[1];
                return inputs[name] || null;
            },
            querySelectorAll: (selector) => selector === 'select' ? []
                : Object.values(inputs).filter((input) => input.type === 'text'),
        };
        button.form = form;
        return form;
    }
    forms = [makeForm()];
    const overviewRows = [ ['Funds', `${funds} bits`], ['Satisfaction', '100 (+2 per tick)'], ['Government Type', 'Loose Despotism'] ];
    const cell = (textContent) => ({ textContent });
    const resourceTable = { querySelectorAll: (selector) => selector.startsWith('thead')
        ? ['Resource', 'Qty', 'Generated', 'Used', 'Net'].map(cell)
        : [['Copper', '15', '0', '10', '-10'], ['Apples', '30', '10', '4', '6']].map((row) => ({ querySelectorAll: () => row.map(cell) })) };
    const resourcePanel = { querySelector: (selector) => selector === '.panel-heading' ? cell('Resources') : resourceTable,
        querySelectorAll: () => [] };
    const nationPanel = { querySelector: () => cell('Nation'),
        querySelectorAll: () => overviewRows.map((row) => ({ querySelectorAll: () => row.map(cell) })) };
    const overview = { querySelectorAll: () => [resourcePanel, nationPanel] };
    const groupDoc = { querySelector: () => ({}), querySelectorAll: () => [{ value: '1', closest: () => cell('Size: 20 Training: 10') }] };
    const sourceContent = { innerHTML: 'new content', childNodes: [{ name: 'replacement' }] };
    const response = { querySelector: (selector) => selector === '#content' ? sourceContent
        : selector === '[name="token_createforces"]' ? null : {} };
    const createResponse = { querySelector: (selector) => selector === '#content' ? sourceContent : {} };
    const content = { replaceChildren() { replacement++; forms = [makeForm('new-token')]; } };
    const doc = {
        querySelectorAll: (selector) => selector === '#content tr'
            ? [{ querySelectorAll: () => ['Cavalry', '200,000', '5 apples/12 hours'].map(cell) }]
            : selector.startsWith('form:has') ? forms : [],
        querySelector: (selector) => selector === '#content' ? content : null,
        importNode: (node) => node,
    };
    globalThis.document = doc;
    globalThis.window = { addEventListener() {}, scrollTo() {}, scrollX: 0, scrollY: 100 };
    globalThis.location = { pathname: `/${page}` };
    const core = {
        el: (tag, attrs, children) => ({ tag, attrs, children }), commas: String, addStyle() {},
        settings: { get: (key) => settings[key] },
        events: { on: (name, cb) => events.set(name, cb), emit: (name, data) => events.get(name)?.(data) },
        confirm: async (options) => { confirmations.push(options); return allow; },
        feedback: { fromDocument: (doc, options) => messages.push({ doc, options }), error: (text, options) => messages.push({ text, options }) },
        http: {
            getDoc: async (url) => { gets.push(url); return url === 'overview.php' ? overview : url === 'groupforces.php' ? groupDoc : createResponse; },
            postForm: async (url, params) => { posts.push({ url, fields: Object.fromEntries(params) }); return response; },
        },
    };
    async function submit(form = forms[0], enter = false) {
        let prevented = false;
        await form.listeners.submit({ submitter: enter ? null : form.button, preventDefault: () => { prevented = true; } });
        assert.equal(prevented, true);
    }
    militaryModule.init(core);
    return { core, forms: () => forms, posts, gets, messages, confirmations, submit,
        disallow: () => { allow = false; }, replacements: () => replacement };
}

test('all military pages POST once, refresh content/tokens, and use normal server feedback', async (t) => {
    for (const page of ['createforces.php', 'makeequipment.php', 'equipforces.php']) {
        const h = harness(t, page);
        await h.submit(undefined, true);
        assert.equal(h.posts.length, 1);
        assert.equal(h.posts[0].url, page);
        assert.equal(h.replacements(), 1);
        assert.equal(h.messages[0].options.additionalErrors, undefined);
        assert.ok(h.gets.includes('overview.php'));
        if (page === 'createforces.php') {
            assert.equal(h.posts[0].fields.createforce, 'Perform');
            assert.ok(h.gets.includes('createforces.php'), 'redirected creation obtains its own fresh token');
        } else if (page === 'makeequipment.php') {
            assert.equal(h.posts[0].fields.times, '1', 'blank placeholder submits one');
            assert.equal(h.posts[0].fields.mode, 'weapons');
        } else {
            assert.equal(h.posts[0].fields.weapon_id, '2');
            assert.equal(h.posts[0].fields.changeweapon, 'Perform');
        }
        await h.submit();
        const token = Object.entries(h.posts[1].fields).find(([name]) => name.startsWith('token_'))[1];
        assert.equal(token, 'new-token');
    }
});

test('force and equipment affordability rejection can cancel before any mutation', async (t) => {
    for (const page of ['createforces.php', 'makeequipment.php']) {
        const h = harness(t, page, { safety: true, funds: 0 });
        h.disallow();
        await h.submit();
        assert.equal(h.posts.length, 0);
        assert.equal(h.replacements(), 0);
        assert.match(h.confirmations[0].title, /Action was not performed:/);
        assert.match(JSON.stringify(h.confirmations[0].body), /Bits/);
        assert.ok(h.confirmations[0].reviewBeforeConfirm, 'other safety warnings remain reviewable');
    }
});

test('confirmation freezes posted quantities and overlapping requests are ignored', async (t) => {
    const h = harness(t, 'createforces.php', { safety: true, funds: 0 });
    let finish, ready;
    const opened = new Promise((resolve) => { ready = resolve; });
    h.core.confirm = () => new Promise((resolve) => { finish = resolve; ready(); });
    const form = h.forms()[0];
    const first = h.submit(form);
    await opened;
    form.fields.size = '600';
    await h.submit(form);
    assert.equal(h.posts.length, 0);
    finish(true);
    await first;
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].fields.size, '6');
});

test('unavailable safety requires explicit bypass, and failed POSTs are never retried', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const h = harness(t, 'makeequipment.php', { safety: true });
    h.core.http.getDoc = async () => { throw new Error('offline'); };
    h.disallow();
    await h.submit();
    assert.equal(h.posts.length, 0);
    assert.equal(h.confirmations[0].title, 'Action safety unavailable');
    h.core.confirm = async () => true;
    let sends = 0;
    h.core.http.postForm = async () => { sends++; throw new Error('connection lost'); };
    await h.submit();
    assert.equal(sends, 1);
    assert.equal(h.replacements(), 0);
    assert.match(h.messages[0].text, /Could not confirm whether.*Reload the page/);
});

test('a disabled selected equipment option also blocks Enter/programmatic submission', async (t) => {
    const h = harness(t, 'equipforces.php');
    const form = h.forms()[0];
    const original = form.querySelectorAll;
    form.querySelectorAll = (selector) => selector === 'select'
        ? [{ options: [{ selected: true, disabled: true }] }] : original(selector);
    await h.submit(form, true);
    assert.equal(h.posts.length, 0);
    assert.equal(h.replacements(), 0);
});
