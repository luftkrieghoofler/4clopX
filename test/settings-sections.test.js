import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsSections, settingsSections } from '../src/ui/settings-sections.js';

function harness(selected = 'General') {
    const doc = { activeElement: null };
    const core = {
        el(tag, attrs = {}, children = []) {
            const handlers = new Map();
            const classes = new Set();
            const node = {
                tag, attrs, children, hidden: false, scrollTop: 0,
                classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
                setAttribute(name, value) { attrs[name] = value; },
                appendChild(child) { children.push(child); return child; },
                contains(child) { return child === node || children.some((item) => item.contains?.(child)); },
                addEventListener(name, handler) { handlers.set(name, handler); },
                fire(name, event) { return handlers.get(name)?.(event); },
                focus() { doc.activeElement?.blur(); doc.activeElement = node; },
                blur() {
                    if (doc.activeElement !== node) return;
                    doc.activeElement = null;
                    // Model the native change-on-blur of a user-edited input.
                    if (node.edited) { node.edited = false; node.fire('change'); }
                },
            };
            for (const [key, handler] of Object.entries(attrs)) {
                if (key.startsWith('on')) node.addEventListener(key.slice(2), handler);
            }
            return node;
        },
    };
    const mounts = [];
    const panels = new Map();
    const selections = [];
    const sections = ['General', 'Market favourites', 'Shortcuts'].map((label) => ({
        label,
        mount(panel) {
            mounts.push(label);
            panels.set(label, panel);
            panel.appendChild(core.el('input'));
        },
    }));
    const view = createSettingsSections(core, sections, {
        selected, onSelect: (label) => selections.push(label),
    }, doc);
    const buttons = view.node.children[0].children;
    return { doc, core, view, mounts, panels, selections, buttons };
}

test('groups existing definitions without dropping new or unsectioned settings', () => {
    const definitions = [
        { key: 'shortcut', section: 'Shortcuts' },
        { key: 'login', section: 'Auto-login' },
        { key: 'action', section: 'Actions' },
        { key: 'deal', section: 'Deals' },
        { key: 'market', section: 'Market' },
        { key: 'future', section: 'Future feature' },
        { key: 'general' },
    ];
    const sections = settingsSections(definitions);
    assert.deepEqual(sections.map(([label]) => label), [
        'General', 'Actions & deals', 'Markets', 'Market favourites', 'Shortcuts', 'Future feature',
    ]);
    assert.deepEqual(sections[0][1].map((def) => def.key), ['login', 'general']);
    assert.deepEqual(sections[1][1].map((def) => def.key), ['action', 'deal']);
    assert.equal(sections.flatMap(([, defs]) => defs).length, definitions.length);
});

test('deep links mount only their destination and focus its accessible tab', () => {
    const h = harness('Shortcuts');
    assert.deepEqual(h.mounts, []);
    h.view.start();
    assert.deepEqual(h.mounts, ['Shortcuts']);
    assert.equal(h.doc.activeElement, h.buttons[2]);
    assert.equal(h.buttons[2].attrs['aria-selected'], 'true');
    assert.equal(h.buttons[0].tabIndex, -1);
    assert.equal(h.panels.get('Shortcuts').hidden, false);
    assert.equal(h.panels.get('Shortcuts').attrs['aria-labelledby'], h.buttons[2].attrs.id);
});

test('switching commits edited values before hiding their section, preserving its DOM and scroll', () => {
    const h = harness();
    h.view.start();
    const panel = h.panels.get('General');
    const input = panel.children[0];
    let saved = 'old';
    input.addEventListener('change', () => {
        assert.equal(panel.hidden, false, 'commit before hiding');
        saved = input.value;
    });
    input.focus();
    input.value = 'renamed shortcut or updated numeric setting';
    input.edited = true;
    panel.scrollTop = 123;
    h.view.select('Market favourites');
    assert.equal(saved, input.value);
    assert.equal(panel.hidden, true);
    assert.equal(h.doc.activeElement, h.buttons[1], 'focus must not be left on a hidden input or the page behind the modal');
    const filter = h.panels.get('Market favourites').children[0];
    filter.value = 'apples';
    h.view.select('General');
    h.view.select('Market favourites');
    assert.equal(filter.value, 'apples');
    assert.equal(panel.scrollTop, 123);
    assert.equal(panel.children[0], input);
    assert.deepEqual(h.mounts, ['General', 'Market favourites']);
});

test('closing can commit a focused edit, and selecting the current tab does not remount it', () => {
    const h = harness();
    h.view.start();
    const input = h.panels.get('General').children[0];
    let saves = 0;
    input.addEventListener('change', () => { saves++; });
    input.focus();
    input.edited = true;
    h.view.commitFocused();
    h.view.commitFocused();
    h.view.select('General');
    assert.equal(saves, 1);
    assert.deepEqual(h.mounts, ['General']);
});

test('keyboard navigation wraps, supports Home/End, and unknown deep links fall back safely', () => {
    const h = harness('No such section');
    h.view.start();
    assert.equal(h.selections.at(-1), 'General');
    for (const [from, key, to] of [
        [0, 'ArrowUp', 2], [2, 'Home', 0], [0, 'End', 2],
        [2, 'ArrowRight', 0], [0, 'ArrowDown', 1], [1, 'ArrowLeft', 0],
    ]) {
        let prevented = false;
        h.buttons[from].fire('keydown', { key, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(h.doc.activeElement, h.buttons[to]);
        assert.equal(h.buttons[to].attrs['aria-selected'], 'true');
    }
    h.view.select('Missing');
    assert.equal(h.selections.at(-1), 'General');
});
