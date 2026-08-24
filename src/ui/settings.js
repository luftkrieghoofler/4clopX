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
import { readFavourites, sortByResourceOrder } from '../lib/favourites.js';
import { marketNotifyEnabled } from './liveupdates.js';

const MODE_LABELS = [['', 'Resources'], ['weapons', 'Weapons'], ['armor', 'Armor']];

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
            .clop-setting-group { font-weight: bold; margin: 12px 0 4px 0; }
            .clop-section-heading { font-weight: bold; font-size: 15px; border-bottom: 1px solid rgba(128,128,128,.4); padding-bottom: 4px; margin: 20px 0 10px 0; }
            .clop-settings-panel .panel-body > .clop-section-heading:first-child { margin-top: 0; }
            .clop-setting label { font-weight: normal; }
            .clop-setting-fav { margin: 0 0 2px 14px; }
            .clop-watch-table { margin-bottom: 8px; }
            .clop-watch-table th, .clop-watch-table td { padding: 3px 8px; }
            .clop-watch-table th:nth-child(n+2), .clop-watch-table td:nth-child(n+2) { width: 56px; text-align: center; }
            .clop-watch-table input[type="checkbox"] { margin: 0; }
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
            // Group by each definition's `section`, in first-seen order
            // (module registration order: Auto-login, Live updates, Market).
            const sections = new Map();
            for (const def of core.settings.all()) {
                const label = def.section || 'General';
                if (!sections.has(label)) sections.set(label, []);
                sections.get(label).push(def);
            }
            for (const [label, defs] of sections) {
                body.appendChild(el('div', { class: 'clop-section-heading' }, [label]));
                for (const def of defs) body.appendChild(settingRow(def));
            }
            body.appendChild(watchedMarketsSection());
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

        // Hardcoded section: per-favourite watch flags (they're a keyed map,
        // which doesn't fit the typed registry).  One table per mode, one
        // row per favourite market (in server resource order), with a
        // Sell and a Buy checkbox column; sides where the market isn't a
        // favourite show a dash, since only favourites can be watched.
        function watchCell(mode, side, id, isFav) {
            if (!isFav) {
                return el('td', { class: 'text-muted', title: 'Not a ★ favourite on this side' }, ['—']);
            }
            const cb = el('input', {
                type: 'checkbox',
                onchange: (ev) => core.marketNotify.set(mode, side, id, ev.target.checked),
            });
            cb.checked = marketNotifyEnabled(mode, side, id);
            return el('td', {}, [cb]);
        }

        function watchedMarketsSection() {
            const blocks = [];
            for (const [mode, modeLabel] of MODE_LABELS) {
                const bySide = {
                    sell: readFavourites('sell', mode),
                    buyer: readFavourites('buyer', mode),
                };
                const byId = new Map();
                for (const side of ['sell', 'buyer']) {
                    for (const f of bySide[side]) {
                        const known = byId.get(f.id);
                        if (!known) byId.set(f.id, { id: f.id, name: f.name });
                        else if (!known.name && f.name) known.name = f.name;
                    }
                }
                if (!byId.size) continue;
                const favSets = {
                    sell: new Set(bySide.sell.map((f) => f.id)),
                    buyer: new Set(bySide.buyer.map((f) => f.id)),
                };
                const tbody = el('tbody');
                for (const market of sortByResourceOrder(mode, [...byId.values()])) {
                    tbody.appendChild(el('tr', {}, [
                        el('td', {}, [market.name || `resource ${market.id}`]),
                        watchCell(mode, 'sell', market.id, favSets.sell.has(market.id)),
                        watchCell(mode, 'buyer', market.id, favSets.buyer.has(market.id)),
                    ]));
                }
                blocks.push(el('div', { class: 'clop-setting-group' }, [modeLabel]));
                blocks.push(el('table', { class: 'table table-condensed clop-watch-table' }, [
                    el('thead', {}, [el('tr', {}, [
                        el('th', {}, ['Market']),
                        el('th', {}, ['Sell']),
                        el('th', {}, ['Buy']),
                    ])]),
                    tbody,
                ]));
            }
            return el('div', {}, [
                el('div', { class: 'clop-section-heading' }, ['Watched favourite markets']),
                el('small', { class: 'text-muted' }, [
                    'Watched markets are checked for alliance/friend orders on every live update, count toward the ' +
                    'blue badges and the tab title, and can raise notifications. Other markets refresh only when ' +
                    'you open their tab.',
                ]),
                ...(blocks.length ? blocks
                    : [el('div', { class: 'text-muted clop-setting-fav' }, ['No favourite markets yet — open a market and hit ☆ Favourite.'])]),
            ]);
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
