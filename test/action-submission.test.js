import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDynamicAction, replaceActionContent } from '../src/ui/action-submission.js';
import { replacePageContent } from '../src/ui/page-content.js';
import { actionsModule } from '../src/ui/actions.js';

function formDataMock(t) {
    t.mock.method(globalThis, 'FormData', function (form) {
        return new URLSearchParams(form.fields);
    });
}

function form(page, token = 'fresh-token') {
    return {
        fields: { recipe_id: '5', times: '3',
            [page === 'actions.php' ? 'token_actions' : 'token_favoriteactions']: token },
        getAttribute: () => page,
    };
}

function feedbackHarness() {
    const messages = [];
    return { messages, feedback: {
        fromDocument: (doc, options) => messages.push({ doc, options }),
        error: (message, options) => messages.push({ message, options }),
    } };
}

test('posts the original submit intent once and refreshes before showing server feedback', async (t) => {
    formDataMock(t);
    for (const [page, name, label, successTitle] of [
        ['actions.php', '', 'Build Basic Factory', 'Action complete'],
        ['actions.php', 'favorite', 'Add to Favorites', 'Favourite added'],
        ['favoriteactions.php', 'perform', '3 times', 'Action complete'],
        ['favoriteactions.php', 'remove', 'Remove', 'Favourite removed'],
        ['overview.php', 'perform', 'This many:', 'Action complete'],
    ]) {
        const response = { querySelector: () => ({}) };
        const { messages, feedback } = feedbackHarness();
        const order = [];
        const core = { feedback, http: { postForm: async (url, params) => {
            order.push('post');
            assert.equal(url, page === 'actions.php' ? page : 'favoriteactions.php');
            assert.equal(params.get('times'), '3');
            assert.equal(params.get('recipe_id'), '5');
            assert.equal(params.get(page === 'actions.php' ? 'token_actions' : 'token_favoriteactions'), 'fresh-token');
            if (name) assert.equal(params.get(name), label, 'not the temporary busy label');
            else assert.equal([...params.keys()].length, 3, 'unnamed submit buttons are omitted');
            return response;
        } } };
        await executeDynamicAction(core, {
            page, form: form(page === 'actions.php' ? page : 'favoriteactions.php'),
            submitter: { name, value: 'Checking safety…', dataset: { clopOldLabel: label } },
            refresh: async (doc) => {
                assert.equal(doc, response);
                assert.equal(messages.length, 0);
                order.push('refresh');
            },
        });
        assert.deepEqual(order, ['post', 'refresh']);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].doc, response);
        assert.equal(messages[0].options.successTitle, successTitle);
    }
});

test('Enter submission uses the page endpoint without requiring a submitter', async (t) => {
    formDataMock(t);
    let posts = 0;
    const { feedback, messages } = feedbackHarness();
    await executeDynamicAction({ feedback, http: { postForm: async (url, params) => {
        posts++;
        assert.equal(url, 'actions.php');
        assert.equal(params.has('favorite'), false);
        return { querySelector: () => ({}) };
    } } }, { page: 'actions.php', form: { ...form('actions.php'), getAttribute: () => '' },
        submitter: null, refresh: async () => {} });
    assert.equal(posts, 1);
    assert.equal(messages[0].options.successTitle, 'Action complete');
});

test('server rejections still refresh rotated tokens and go through normal feedback', async (t) => {
    formDataMock(t);
    const response = { errors: ['Not enough copper.'], querySelector: () => ({}) };
    const { messages, feedback } = feedbackHarness();
    let refreshed = false;
    await executeDynamicAction({ feedback, http: { postForm: async () => response } }, {
        page: 'actions.php', form: form('actions.php'),
        refresh: async (doc) => { assert.equal(doc, response); refreshed = true; },
    });
    assert.equal(refreshed, true);
    assert.equal(messages[0].doc, response);
    assert.equal(messages[0].options.errorTitle, 'Action failed');
});

test('lost responses and expired sessions never retry or claim success', async (t) => {
    formDataMock(t);
    t.mock.method(console, 'warn', () => {});
    for (const expired of [false, true]) {
        const { messages, feedback } = feedbackHarness();
        let posts = 0;
        await executeDynamicAction({ feedback, http: { postForm: async () => {
            posts++;
            if (expired) return { querySelector: () => null };
            throw new Error('Connection lost');
        } } }, { page: 'actions.php', form: form('actions.php'),
            refresh: async () => assert.fail('must not refresh an unknown response') });
        assert.equal(posts, 1);
        assert.equal(messages.length, 1);
        assert.match(messages[0].message, /Could not confirm whether.*Reload the page/);
        assert.equal(messages[0].doc, undefined);
    }
});

test('refresh failure retains server results and warns against retrying', async (t) => {
    formDataMock(t);
    t.mock.method(console, 'warn', () => {});
    const response = { querySelector: () => ({}) };
    const { messages, feedback } = feedbackHarness();
    let posts = 0;
    await executeDynamicAction({ feedback, http: { postForm: async () => {
        posts++;
        return response;
    } } }, { page: 'favoriteactions.php', form: form('favoriteactions.php'),
        refresh: async () => { throw new Error('Missing page content'); } });
    assert.equal(posts, 1);
    assert.equal(messages[0].doc, response);
    assert.match(messages[0].options.additionalErrors[0], /Reload the page before trying again/);
});

test('page replacement omits only top-level server feedback without modifying its source', () => {
    const nodes = [
        { id: 'error', matches: () => true },
        { id: 'info', matches: () => true },
        { id: 'funds', matches: () => false },
        { id: 'actions', matches: () => false },
        { id: 'whitespace' },
    ];
    let replacement;
    const currentDoc = {
        querySelector: () => ({ replaceChildren: (...children) => { replacement = children; } }),
        importNode: (node) => ({ ...node }),
    };
    const sourceDoc = { querySelector: () => ({ innerHTML: 'updated content', childNodes: nodes }) };
    assert.equal(replacePageContent(currentDoc, sourceDoc, undefined, { omitFeedback: true }).changed, true);
    assert.deepEqual(replacement.map(({ id }) => id), ['funds', 'actions', 'whitespace']);
    assert.equal(nodes.length, 5, 'feedback still available to the modal/toast parser');
});

function quantityForm(id, quantity, hidden = false) {
    const input = { value: quantity };
    return { input, querySelector(selector) {
        if (selector === 'input[name="recipe_id"]') return { value: id };
        if (selector === 'input[name="times"][type="text"]') return hidden ? null : input;
        if (selector.includes('token_actions')) return { value: 'token' };
        return null;
    } };
}

test('replaces every action form/token while retaining editable, not preset, quantities', () => {
    const oldForms = [quantityForm('5', '42'), quantityForm('6', '7'), quantityForm('5', '3', true)];
    const freshForms = [quantityForm('5', '1'), quantityForm('6', '1'), quantityForm('5', '9', true)];
    let currentForms = oldForms;
    const doc = {
        querySelectorAll: () => currentForms,
        querySelector: () => ({ replaceChildren: (...forms) => { currentForms = forms; } }),
        importNode: (node) => node,
    };
    replaceActionContent(doc, {
        querySelector: () => ({ innerHTML: 'fresh', childNodes: freshForms }),
    });
    assert.equal(currentForms[0], freshForms[0]);
    assert.deepEqual(currentForms.map(({ input }) => input.value), ['42', '7', '9']);

    replaceActionContent(doc, { querySelector: () => ({ innerHTML: 'No favorites', childNodes: [] }) });
    assert.deepEqual(currentForms, [], 'removing the last favourite clears the list');
    assert.throws(() => replaceActionContent(doc, { querySelector: () => null }), /content container/);
});

test('bound forms stay dynamic after replacement, serialize clicks, and retain the safety gate', async (t) => {
    formDataMock(t);
    const originals = Object.fromEntries(['document', 'window', 'location'].map((key) => [key, globalThis[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    });
    // No browser layout in this test; the renderer itself is covered above.
    t.mock.method(globalThis, 'setTimeout', () => 0);
    globalThis.window = { scrollX: 0, scrollY: 400, scrollTo() {} };
    const resources = {
        querySelectorAll: () => [{
            querySelector: (selector) => selector === '.panel-heading' ? { textContent: 'Resources' } : {
                querySelectorAll: (selector) => selector === 'thead td, thead th'
                    ? ['Resource', 'Qty', 'Generated', 'Used', 'Net'].map((textContent) => ({ textContent })) : [],
            },
            querySelectorAll: () => [],
        }],
    };

    for (const page of ['actions.php', 'favoriteactions.php', 'overview.php']) {
        globalThis.location = { pathname: `/${page}` };
        const endpoint = page === 'actions.php' ? page : 'favoriteactions.php';
        const tokenName = endpoint === 'actions.php' ? 'token_actions' : 'token_favoriteactions';
        function makeForm(token) {
            const fields = { recipe_id: '5', times: '3', [tokenName]: token };
            const input = { get value() { return fields.times; }, set value(v) { fields.times = v; } };
            const listeners = {};
            return {
                fields, listeners,
                classList: { toggle() {} },
                addEventListener: (name, listener) => { listeners[name] = listener; },
                getAttribute: () => endpoint,
                closest: () => null,
                querySelectorAll: () => [],
                querySelector(selector) {
                    if (selector === 'input[name="recipe_id"]') return { value: fields.recipe_id };
                    if (selector.includes('times')) return input;
                    return selector.includes(tokenName) ? { value: fields[tokenName] } : null;
                },
            };
        }
        let current = [makeForm('initial'), makeForm('initial')];
        const listeners = {};
        globalThis.document = {
            querySelectorAll: (selector) => selector === 'form' ? current : [],
            querySelector: (selector) => selector === '#content'
                ? { replaceChildren: (...forms) => { current = forms; } } : null,
            importNode: (node) => node,
        };
        let safe = false;
        let confirmations = 0;
        let posts = 0;
        let release;
        const { feedback, messages } = feedbackHarness();
        const core = {
            feedback, addStyle() {}, commas: String,
            el: (tag, attrs, children) => ({ tag, attrs, children, style: {} }),
            settings: { get: () => safe },
            confirm: async () => { confirmations++; return false; },
            events: { on: (name, callback) => { listeners[name] = callback; }, emit() {} },
            overview: { refresh: async () => {
                current = [makeForm(`token-${posts}`), makeForm(`token-${posts}`)];
                listeners['overview:contentReplaced']();
            } },
            http: {
                getDoc: async (url) => url === 'overview.php' ? resources : { querySelectorAll: () => [] },
                postForm: async (url, params) => {
                    assert.equal(params.get(tokenName), posts ? `token-${posts}` : 'initial');
                    posts++;
                    if (posts === 1) await new Promise((resolve) => { release = resolve; });
                    return { querySelector: (selector) => selector === 'a[href="logout.php"]' ? {}
                        : { innerHTML: `response-${posts}`, childNodes: [makeForm(`token-${posts}`), makeForm(`token-${posts}`)] },
                    querySelectorAll: () => [] };
                },
            },
        };
        actionsModule.init(core);
        async function submit(target) {
            let prevented = false;
            await target.listeners.submit({
                submitter: { name: page === 'actions.php' ? '' : 'perform', value: 'Build', dataset: {} },
                preventDefault: () => { prevented = true; },
            });
            assert.equal(prevented, true);
        }
        const first = submit(current[0]);
        await submit(current[1]);
        assert.equal(posts, 1, 'second form cannot race the shared token');
        release();
        await first;
        await submit(current[0]);
        assert.equal(posts, 2, 'replacement form is rebound with its new token');
        assert.equal(messages.length, 2);
        assert.ok(messages.every(({ options }) => options.successTitle === 'Action complete'));
        safe = true;
        await submit(current[0]);
        assert.equal(confirmations, 1, 'unavailable mechanics still require safety confirmation');
        assert.equal(posts, 2, 'cancelling the safety dialog never posts');
    }
});
