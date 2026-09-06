import test from 'node:test';
import assert from 'node:assert/strict';
import { bindOverviewBuildings } from '../src/ui/overview-buildings.js';

function harness(t) {
    t.mock.method(globalThis, 'FormData', function (form) { return new URLSearchParams(form.fields); });
    const forms = [];
    function makeForm(token = 'token-1', name = 'Basic Factory') {
        const listeners = {};
        const classes = new Set();
        const fields = {
            token_overview: token, resource_id: '5',
            recycleamount: '3', disableamount: '2', reenableamount: '1',
        };
        const buttons = Object.fromEntries(['disable', 'reenable', 'recycle'].map((intent) => [intent, {
            name: intent,
            value: `${intent === 'recycle' ? 'Destroy' : intent} ${name}`,
            onclick: `return confirm('Really destroy ${name}? You will lose 5 satisfaction for each building you destroy!')`,
            getAttribute(key) { return this[key]; },
            removeAttribute(key) { delete this[key]; },
        }]));
        const form = {
            fields, buttons, listeners, classes,
            classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key) },
            closest: () => ({ querySelector: () => ({ textContent: name }) }),
            addEventListener(name, handler) { assert.equal(listeners[name], undefined); listeners[name] = handler; },
            querySelector(selector) {
                if (selector === 'input[name="recycle"][type="submit"]') return buttons.recycle;
                const key = selector.match(/name="([^"]+)"/)?.[1];
                return Object.hasOwn(fields, key) ? { value: fields[key] } : null;
            },
        };
        for (const button of Object.values(buttons)) button.form = form;
        forms.push(form);
        return form;
    }
    let allow = true;
    const confirmations = [];
    const posts = [];
    const feedback = [];
    const events = {};
    let refreshes = 0;
    const response = { querySelector: () => ({}) };
    const core = {
        el: (tag, attrs, children) => ({ tag, attrs, children }),
        commas: (number) => number.toLocaleString('en-US'),
        addStyle() {},
        confirm: async (options) => { confirmations.push(options); return allow; },
        events: { on: (name, callback) => { events[name] = callback; } },
        http: { postForm: async (url, params) => {
            posts.push({ url, params: Object.fromEntries(params) });
            return response;
        } },
        overview: { refresh: async () => { refreshes++; } },
        feedback: {
            fromDocument: (doc, options) => feedback.push({ doc, options }),
            error: (message, options) => feedback.push({ message, options }),
        },
    };
    const doc = { querySelectorAll: () => forms };
    async function submit(form, intent, fallback = false) {
        const button = form.buttons[intent];
        if (fallback) form.listeners.click({ target: { closest: () => button } });
        let prevented = false;
        await form.listeners.submit({
            submitter: fallback ? null : button,
            preventDefault: () => { prevented = true; },
        });
        assert.equal(prevented, true);
    }
    return { core, makeForm, submit, confirmations, posts, feedback, events, response,
        bind: () => bindOverviewBuildings(core, doc),
        disallow: () => { allow = false; },
        refreshes: () => refreshes };
}

test('disable and re-enable post only the chosen intent, refresh, and show normal feedback', async (t) => {
    const h = harness(t);
    const form = h.makeForm();
    h.bind();
    for (const intent of ['disable', 'reenable']) {
        await h.submit(form, intent, intent === 'reenable');
        const { url, params } = h.posts.at(-1);
        assert.equal(url, 'overview.php');
        assert.equal(params.token_overview, 'token-1');
        assert.equal(params.resource_id, '5');
        assert.equal(params[intent], form.buttons[intent].value);
        assert.equal(params.recycle, undefined);
        assert.equal(params[intent === 'disable' ? 'reenable' : 'disable'], undefined);
    }
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.refreshes(), 2);
    assert.equal(h.feedback[0].doc, h.response);
    assert.equal(h.feedback[0].options.successTitle, 'Buildings disabled');
    assert.equal(h.feedback[1].options.successTitle, 'Buildings re-enabled');
});

test('Destroy replaces the native confirm and cancellation never posts', async (t) => {
    const h = harness(t);
    const form = h.makeForm();
    h.bind();
    assert.equal(form.buttons.recycle.onclick, undefined);
    h.disallow();
    await h.submit(form, 'recycle');
    assert.equal(h.posts.length, 0);
    assert.equal(h.refreshes(), 0);
    assert.equal(form.classes.size, 0);
    assert.equal(form.buttons.recycle.value, 'Destroy Basic Factory');
    const options = h.confirmations[0];
    assert.equal(options.title, 'Destroy Basic Factory × 3?');
    assert.equal(options.confirmClass, 'btn-danger');
    assert.equal(options.cancelLabel, 'Cancel');
    assert.match(JSON.stringify(options.body), /This cannot be undone/);
    assert.match(JSON.stringify(options.body), /You will lose 5 satisfaction for each building you destroy!/);
});

test('destroy sends exactly the confirmed quantity and blocks overlapping building submissions', async (t) => {
    const h = harness(t);
    const form = h.makeForm();
    const second = h.makeForm();
    h.bind();
    let confirm;
    h.core.confirm = () => new Promise((resolve) => { confirm = resolve; });
    const first = h.submit(form, 'recycle');
    form.fields.recycleamount = '300';
    await h.submit(second, 'disable');
    assert.equal(h.posts.length, 0);
    confirm(true);
    await first;
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].params.recycleamount, '3');
    assert.equal(h.posts[0].params.recycle, 'Destroy Basic Factory');
    assert.equal(h.refreshes(), 1);
    assert.equal(h.feedback[0].options.successTitle, 'Buildings destroyed');
});

test('refresh binds replacement controls and their new tokens without rebinding old forms', async (t) => {
    const h = harness(t);
    h.makeForm();
    h.bind();
    const fresh = h.makeForm('token-2');
    h.events['overview:contentReplaced']();
    h.events['overview:contentReplaced']();
    await h.submit(fresh, 'disable');
    assert.equal(h.posts[0].params.token_overview, 'token-2');
    await h.submit(fresh, 'recycle');
    assert.equal(h.confirmations.length, 1, 'replacement Destroy still requires confirmation');
});

test('unknown submit intent cannot accidentally destroy buildings', async (t) => {
    const h = harness(t);
    const form = h.makeForm();
    h.bind();
    await h.submit(form, 'unknown');
    assert.equal(h.posts.length, 0);
    assert.equal(h.confirmations.length, 0);
});

test('failed building requests are not retried and release the busy state', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const h = harness(t);
    const form = h.makeForm();
    h.bind();
    let sends = 0;
    h.core.http.postForm = async () => { sends++; throw new Error('Connection lost'); };
    await h.submit(form, 'disable');
    assert.equal(sends, 1);
    assert.equal(h.refreshes(), 0);
    assert.equal(form.classes.size, 0);
    assert.match(h.feedback[0].message, /Could not confirm whether.*Reload the page/);
});
