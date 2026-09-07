import test from 'node:test';
import assert from 'node:assert/strict';

test('bootstrapping keeps core and its secret-storage methods off page globals', async (t) => {
    for (const [key, value] of Object.entries({
        __CLOPX_VERSION__: 'test', window: {}, unsafeWindow: {},
    })) {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => {
            if (original) Object.defineProperty(globalThis, key, original);
            else delete globalThis[key];
        });
    }
    const { core } = await import('../src/core.js');
    const register = t.mock.method(core, 'register', () => {});
    const boot = t.mock.method(core, 'boot', () => {});
    await import('../src/main.js');
    assert.ok(register.mock.callCount() > 0);
    assert.equal(boot.mock.callCount(), 1);
    assert.deepEqual(Object.keys(unsafeWindow), []);
    assert.deepEqual(Object.keys(window), []);
});
