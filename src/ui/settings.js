// Settings panel: a ⚙ entry in the navbar's right group (next to the
// live-update countdown) opening a modal overlay that renders every
// setting registered in core.settings — checkboxes for bools, inputs for
// numbers, buttons for actions.  Values save immediately on change;
// definitions flagged `reload: true` are marked as taking effect after a
// page reload, and `onChange` hooks let modules react to edits live.
//
// The panel is rendered purely from the registry, so any module's
// core.settings.define() shows up here automatically.

import { isLoggedInDoc } from '../adapters/session.js';

export const settingsModule = {
    name: 'settings',

    matches: () => true,

    init(core) {
        if (!isLoggedInDoc(document)) return;
        const el = core.el.bind(core);

        core.addStyle(`
            .clop-settings-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.55); z-index: 10000; display: flex; align-items: flex-start; justify-content: center; padding-top: 60px; }
            .clop-settings-panel { width: 520px; max-width: 92vw; margin: 0; }
            .clop-settings-panel .panel-body { max-height: 70vh; overflow-y: auto; }
            .clop-settings-panel .panel-heading .close { line-height: 1; }
            .clop-setting { margin-bottom: 14px; }
            .clop-setting.checkbox { margin-top: 0; }
            .clop-setting small { display: block; margin-top: 2px; }
            .clop-setting-num { width: 90px; display: inline-block; margin-left: 8px; }
        `);

        let overlay = null;

        function onKey(ev) {
            if (ev.key === 'Escape') closePanel();
        }

        function closePanel() {
            if (!overlay) return;
            overlay.remove();
            overlay = null;
            document.removeEventListener('keydown', onKey);
        }

        function openPanel() {
            if (overlay) return;
            const body = el('div', { class: 'panel-body' });
            for (const def of core.settings.all()) body.appendChild(settingRow(def));
            overlay = el('div', {
                class: 'clop-settings-overlay',
                onclick: (ev) => { if (ev.target === overlay) closePanel(); },
            }, [
                el('div', { class: 'panel panel-default clop-settings-panel' }, [
                    el('div', { class: 'panel-heading' }, [
                        el('button', { class: 'close', type: 'button', html: '&times;', onclick: closePanel }),
                        '4clopX Settings',
                    ]),
                    body,
                ]),
            ]);
            document.body.appendChild(overlay);
            document.addEventListener('keydown', onKey);
        }

        function changed(def, value) {
            core.settings.set(def.key, value);
            if (def.onChange) {
                try { def.onChange(value); } catch (e) { console.error('[4clopX] setting onChange failed:', e); }
            }
        }

        const reloadNote = (def) => (def.reload
            ? [el('span', { class: 'text-muted' }, [' (takes effect after reload)'])]
            : []);
        const description = (def) => (def.description
            ? [el('small', { class: 'text-muted' }, [def.description])]
            : []);

        function settingRow(def) {
            if (def.type === 'bool') {
                const cb = el('input', {
                    type: 'checkbox',
                    onchange: (ev) => changed(def, ev.target.checked),
                });
                cb.checked = !!core.settings.get(def.key);
                return el('div', { class: 'checkbox clop-setting' }, [
                    el('label', {}, [cb, ` ${def.label}`, ...reloadNote(def)]),
                    ...description(def),
                ]);
            }
            if (def.type === 'number') {
                const input = el('input', { class: 'form-control input-sm clop-setting-num', type: 'text' });
                input.value = String(core.settings.get(def.key));
                input.addEventListener('change', () => {
                    const n = Number(input.value);
                    if (Number.isFinite(n)) changed(def, n);
                    else input.value = String(core.settings.get(def.key));  // reject garbage
                });
                return el('div', { class: 'clop-setting' }, [
                    el('label', {}, [def.label, input, ...reloadNote(def)]),
                    ...description(def),
                ]);
            }
            if (def.type === 'button') {
                const btn = el('button', { class: 'btn btn-default btn-sm', type: 'button' }, [def.label]);
                btn.addEventListener('click', () => {
                    btn.disabled = true;
                    Promise.resolve()
                        .then(() => def.handler && def.handler())
                        .then(() => { btn.textContent = '✓ done'; })
                        .catch((e) => { btn.textContent = `failed: ${e.message || e}`; })
                        .finally(() => setTimeout(() => {
                            btn.textContent = def.label;
                            btn.disabled = false;
                        }, 1500));
                });
                return el('div', { class: 'clop-setting' }, [btn, ...description(def)]);
            }
            console.warn(`[4clopX] setting "${def.key}" has unknown type "${def.type}"`);
            return el('div');
        }

        const navRight = document.querySelector('nav.navbar ul.navbar-right');
        if (!navRight) return;
        navRight.insertBefore(el('li', {}, [el('a', {
            style: 'cursor: pointer;',
            title: '4clopX settings',
            onclick: openPanel,
        }, ['⚙'])]), navRight.firstElementChild);
    },
};
