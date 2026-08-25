import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const previousVersion = globalThis.__CLOPX_VERSION__;
const previousStorage = globalThis.localStorage;
const previousWindow = globalThis.window;

const values = new Map();
let writes = 0;
let storageListener = null;

globalThis.__CLOPX_VERSION__ = 'test';
globalThis.localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => {
        writes += 1;
        values.set(key, String(value));
    },
};
globalThis.window = {
    addEventListener: (type, handler) => {
        if (type === 'storage') storageListener = handler;
    },
};

const { core } = await import('../src/core.js');

after(() => {
    if (previousVersion === undefined) delete globalThis.__CLOPX_VERSION__;
    else globalThis.__CLOPX_VERSION__ = previousVersion;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
});

test('dispatches validated setting changes locally and across tabs without write-back', () => {
    const applied = [];
    const events = [];
    core.settings.define({
        key: 'test.colour',
        type: 'choice',
        options: [{ value: 'blue' }, { value: 'grey' }],
        default: 'blue',
        onChange: (value, context) => applied.push({ value, source: context.source }),
    });
    core.events.on('settings:changed', (change) => events.push(change));
    core.settings.startSync();

    core.settings.set('test.colour', 'grey');
    assert.deepEqual(applied, [{ value: 'grey', source: 'local' }]);
    assert.deepEqual(events, [{ key: 'test.colour', value: 'grey', source: 'local' }]);
    assert.equal(writes, 1);

    values.set('clopx.setting.test.colour', 'blue');
    storageListener({ key: 'clopx.setting.test.colour' });
    assert.deepEqual(applied.at(-1), { value: 'blue', source: 'remote' });
    assert.deepEqual(events.at(-1), { key: 'test.colour', value: 'blue', source: 'remote' });
    assert.equal(writes, 1, 'remote dispatch must not write the setting again');

    values.set('clopx.setting.test.colour', 'invalid');
    storageListener({ key: 'clopx.setting.test.colour' });
    assert.deepEqual(applied.at(-1), { value: 'blue', source: 'remote' },
        'remote values use the same validation and fallback as settings.get()');
});

test('ignores unrelated storage keys', () => {
    const before = writes;
    storageListener({ key: 'clopx.live.friendly' });
    assert.equal(writes, before);
});
