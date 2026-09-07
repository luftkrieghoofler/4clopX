import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchedTickSeconds } from '../src/adapters/header.js';
import { createTickTimer } from '../src/ui/tick-timer.js';

test('reads the numeric stock initializer even when the theme leaves the timer empty', () => {
    const doc = (scripts, textContent = '') => ({
        querySelectorAll: () => scripts.map(textContent => ({ textContent })),
        querySelector: () => ({ textContent }),
    });
    assert.equal(fetchedTickSeconds(doc([
        'function doCountdownTick(countdown_seconds) {}',
        'window.onload = function(){ doCountdownTick(3723); };',
    ])), 3723);
    assert.equal(fetchedTickSeconds(doc([], '0:04:05')), 245);
    assert.equal(fetchedTickSeconds(doc([], 'NOW!')), 0);
    assert.equal(fetchedTickSeconds(doc(['doCountdownTick(getTimer());'])), null);
});

function harness() {
    let time = 100000;
    let id = 0;
    const jobs = new Map();
    const events = {};
    const node = { textContent: '1:00:00' };
    const doc = {
        querySelector: () => node,
        addEventListener: (name, handler) => { events[name] = handler; },
    };
    const page = {
        doCountdownTick() { throw new Error('Stock countdown should be replaced'); },
        setTimeout(fn) { jobs.set(++id, fn); return id; },
        clearTimeout(id) { jobs.delete(id); },
    };
    return {
        sync: createTickTimer(doc, page, () => time), node, page, jobs, events,
        advance(ms) { time += ms; },
    };
}

test('refreshes immediately and catches up after missed background callbacks', () => {
    const h = harness();
    h.sync({ at: 100000, tickSeconds: 600 });
    assert.equal(h.node.textContent, '0:10:00');
    h.advance(125000);
    // An already-queued stock callback carries a stale count. Ignore it.
    h.page.doCountdownTick(599);
    assert.equal(h.node.textContent, '0:07:55');
    assert.equal(h.jobs.size, 1);
    h.advance(65000);
    h.events.visibilitychange();
    assert.equal(h.node.textContent, '0:06:50');
    assert.equal(h.jobs.size, 1);
    h.sync({ at: 290000, tickSeconds: 7200 });
    assert.equal(h.node.textContent, '2:00:00');
    assert.equal(h.jobs.size, 1);
});

test('cross-tab snapshots account for delivery delay and ignore stale or missing values', () => {
    const h = harness();
    h.advance(10000);
    h.sync({ at: 100000, tickSeconds: 60 });
    assert.equal(h.node.textContent, '0:00:50');
    for (const snapshot of [null, { at: 110000 }, { at: 110000, tickSeconds: null },
        { at: 110000, tickSeconds: -1 }, { at: 99000, tickSeconds: 999 }]) {
        h.sync(snapshot);
        assert.equal(h.node.textContent, '0:00:50');
    }
    h.advance(51000);
    h.page.doCountdownTick(49);
    assert.equal(h.node.textContent, 'NOW!');
    h.sync({ at: 161000, tickSeconds: 7199 });
    assert.equal(h.node.textContent, '1:59:59');
});

test('missing timer data leaves the native countdown untouched', () => {
    const h = harness();
    const original = h.page.doCountdownTick;
    h.sync({ at: 100000, tickSeconds: null });
    assert.equal(h.page.doCountdownTick, original);
    assert.equal(h.jobs.size, 0);
});
