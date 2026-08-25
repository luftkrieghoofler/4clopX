// Settings panel: a ⚙ entry in the navbar's right group (next to the
// live-update countdown) opening a modal overlay that renders every
// setting registered in core.settings — checkboxes for bools, inputs for
// numbers, segmented controls for choices, and buttons for actions.  Values save immediately on change;
// definitions flagged `reload: true` are marked as taking effect after a
// page reload, and core-dispatched `onChange` hooks let modules react to
// edits live in every open tab.
//
// The panel is rendered purely from the registry, so any module's
// core.settings.define() shows up here automatically.

import { isLoggedInDoc } from '../adapters/session.js';
import { marketPageUrl, marketResourcesFromDocument } from '../adapters/market.js';
import {
    readFavourites, sortByResourceOrder, readMarketCatalog, writeMarketCatalog,
    setFavourite, favouriteStorageChange, marketCatalogStorageMode,
} from '../lib/favourites.js';
import { marketNotifyEnabled, forgetMarket } from './liveupdates.js';

const MODE_LABELS = [['', 'Resources'], ['weapons', 'Weapons'], ['armor', 'Armor']];

export const settingsModule = {
    name: 'settings',

    matches: () => true,

    init(core) {
        if (!isLoggedInDoc(document)) return;
        const el = core.el.bind(core);

        core.addStyle(`
            .clop-settings-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.55); z-index: 10000; display: flex; align-items: flex-start; justify-content: center; padding-top: 60px; }
            .clop-settings-panel { width: 620px; max-width: 92vw; margin: 0; }
            .clop-settings-panel .panel-body { max-height: 70vh; overflow-y: auto; }
            .clop-settings-panel .panel-heading .close { line-height: 1; }
            .clop-setting { margin-bottom: 14px; }
            .clop-setting.checkbox { margin-top: 0; }
            .clop-setting-child { margin-left: 20px; }
            .clop-setting-child.clop-setting-disabled { opacity: .62; }
            .clop-setting small { display: block; margin-top: 2px; }
            .clop-setting-num { width: 90px; display: inline-block; margin-left: 8px; }
            .clop-setting-choice { display: inline-block; margin-top: 5px; }
            .clop-setting-choice .btn.active { color: #fff; background: #5bc0de; border-color: #46b8da; box-shadow: none; text-shadow: none; }
            .clop-choice-example { margin-left: 4px; }
            .clop-choice-example-accent { background-color: var(--clop-market-order-badge-color, #5bc0de) !important; background-image: none !important; color: #fff !important; text-shadow: none !important; }
            .clop-setting-choice .btn.active .clop-choice-example { box-shadow: 0 0 0 1px rgba(255,255,255,.9), 0 0 0 2px rgba(0,0,0,.22); }
            .clop-setting-group { font-weight: bold; margin: 12px 0 4px 0; }
            .clop-section-heading { font-weight: bold; font-size: 15px; border-bottom: 1px solid rgba(128,128,128,.4); padding-bottom: 4px; margin: 20px 0 10px 0; }
            .clop-settings-panel .panel-body > .clop-section-heading:first-child { margin-top: 0; }
            .clop-setting label { font-weight: normal; }
            .clop-market-editor-heading { width: 100%; padding: 0; color: inherit; text-align: left; font-weight: bold; text-decoration: none !important; }
            .clop-market-editor-heading .clop-chevron { display: inline-block; width: 16px; }
            .clop-market-editor-body { padding-top: 10px; }
            .clop-market-editor-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
            .clop-market-editor-controls .btn-group .btn.active { color: #fff; background: #5bc0de; border-color: #46b8da; box-shadow: none; text-shadow: none; }
            .clop-market-editor-search { width: 165px; }
            .clop-market-editor-dna { margin: 0 0 0 auto; font-weight: normal; white-space: nowrap; }
            .clop-market-editor-dna input { margin-right: 4px; }
            .clop-market-editor-table { margin-bottom: 4px; }
            .clop-market-editor-table th { background: #fff; position: sticky; top: 0; z-index: 1; }
            .clop-market-editor-table th:not(:first-child), .clop-market-editor-table td:not(:first-child) { width: 68px; text-align: center; }
            .clop-market-editor-empty { padding: 12px !important; }
        `);

        let overlay = null;
        const settingRefreshers = new Map();
        const dependencyRefreshers = [];
        let marketEditor = null;

        core.events.on('settings:changed', ({ key, value }) => {
            const refresh = settingRefreshers.get(key);
            if (refresh) refresh(value);
            for (const dependency of dependencyRefreshers) {
                if (dependency.parent === key) dependency.refresh();
            }
        });
        core.events.on('market:friendlyCache', () => {
            if (marketEditor) marketEditor.refreshWatches();
        });
        core.events.on('market:favouritesChanged', (change) => {
            if (marketEditor) marketEditor.refreshFavourites(change);
        });
        core.events.on('settings:close', closePanel);
        window.addEventListener('storage', (ev) => {
            const favouriteChange = favouriteStorageChange(ev.key);
            if (favouriteChange) core.events.emit('market:favouritesChanged', favouriteChange);
            const catalogMode = marketCatalogStorageMode(ev.key);
            if (catalogMode !== null && marketEditor) marketEditor.refreshCatalog(catalogMode);
        });

        function onKey(ev) {
            if (ev.key === 'Escape') closePanel();
        }

        function closePanel() {
            if (!overlay) return;
            overlay.remove();
            overlay = null;
            settingRefreshers.clear();
            dependencyRefreshers.length = 0;
            if (marketEditor) marketEditor.destroy();
            marketEditor = null;
            document.removeEventListener('keydown', onKey);
        }

        function openPanel() {
            if (overlay) return;
            settingRefreshers.clear();
            dependencyRefreshers.length = 0;
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
            marketEditor = marketEditorSection();
            body.appendChild(marketEditor.node);
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
        }

        const reloadNote = (def) => (def.reload
            ? [el('span', { class: 'text-muted' }, [' (takes effect after reload)'])]
            : []);
        const description = (def) => (def.description
            ? [el('small', { class: 'text-muted' }, [def.description])]
            : []);

        function applyStockBadgeStyle(node) {
            const probe = el('span', { class: 'badge' }, ['0']);
            probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
            document.body.appendChild(probe);
            const style = window.getComputedStyle(probe);
            node.style.backgroundColor = style.backgroundColor;
            node.style.backgroundImage = style.backgroundImage;
            node.style.color = style.color;
            probe.remove();
        }

        function withParent(def, row, controls) {
            if (!def.parent) return row;
            row.classList.add('clop-setting-child');
            const refresh = () => {
                const enabled = !!core.settings.get(def.parent);
                row.classList.toggle('clop-setting-disabled', !enabled);
                for (const control of controls) control.disabled = !enabled;
            };
            dependencyRefreshers.push({ parent: def.parent, refresh });
            refresh();
            return row;
        }

        function settingRow(def) {
            if (def.type === 'bool') {
                const cb = el('input', {
                    type: 'checkbox',
                    onchange: (ev) => changed(def, ev.target.checked),
                });
                cb.checked = !!core.settings.get(def.key);
                settingRefreshers.set(def.key, (value) => { cb.checked = !!value; });
                return withParent(def, el('div', { class: 'checkbox clop-setting' }, [
                    el('label', {}, [cb, ` ${def.label}`, ...reloadNote(def)]),
                    ...description(def),
                ]), [cb]);
            }
            if (def.type === 'number') {
                const input = el('input', { class: 'form-control input-sm clop-setting-num', type: 'text' });
                input.value = String(core.settings.get(def.key));
                settingRefreshers.set(def.key, (value) => { input.value = String(value); });
                input.addEventListener('change', () => {
                    const n = Number(input.value);
                    if (Number.isFinite(n)) changed(def, n);
                    else input.value = String(core.settings.get(def.key));  // reject garbage
                });
                return withParent(def, el('div', { class: 'clop-setting' }, [
                    el('label', {}, [def.label, input, ...reloadNote(def)]),
                    ...description(def),
                ]), [input]);
            }
            if (def.type === 'choice') {
                const buttons = new Map();
                const refresh = (value) => {
                    for (const [candidate, button] of buttons) {
                        const selected = candidate === value;
                        button.classList.toggle('active', selected);
                        button.setAttribute('aria-checked', selected ? 'true' : 'false');
                    }
                };
                const select = (value) => changed(def, value);
                const current = core.settings.get(def.key);
                const choices = (def.options || []).map((option) => {
                    const selected = option.value === current;
                    const children = [option.label];
                    if (option.example) {
                        const example = el('span', {
                            class: `badge clop-choice-example ${option.example.class || ''}`,
                        }, [String(option.example.text)]);
                        if (option.example.stock) applyStockBadgeStyle(example);
                        children.push(example);
                    }
                    const button = el('button', {
                        class: `btn btn-default btn-sm${selected ? ' active' : ''}`,
                        type: 'button',
                        role: 'radio',
                        'aria-checked': selected ? 'true' : 'false',
                        onclick: () => select(option.value),
                    }, children);
                    buttons.set(option.value, button);
                    return button;
                });
                settingRefreshers.set(def.key, refresh);
                return withParent(def, el('div', { class: 'clop-setting' }, [
                    el('div', {}, [def.label, ...reloadNote(def)]),
                    el('div', {
                        class: 'btn-group clop-setting-choice',
                        role: 'radiogroup',
                        'aria-label': def.label,
                    }, choices),
                    ...description(def),
                ]), [...buttons.values()]);
            }
            if (def.type === 'button') {
                const btn = el('button', { class: 'btn btn-default btn-sm', type: 'button' }, [def.label]);
                if (def.feedback === false) {
                    btn.addEventListener('click', () => {
                        Promise.resolve()
                            .then(() => def.handler && def.handler())
                            .catch((e) => console.error(`[4clopX] setting action "${def.key}" failed:`, e));
                    });
                    return withParent(def,
                        el('div', { class: 'clop-setting' }, [btn, ...description(def)]), [btn]);
                }
                btn.addEventListener('click', () => {
                    btn.disabled = true;
                    Promise.resolve()
                        .then(() => def.handler && def.handler())
                        .then(() => { btn.textContent = '✓ done'; })
                        .catch((e) => { btn.textContent = `failed: ${e.message || e}`; })
                        .finally(() => setTimeout(() => {
                            btn.textContent = def.label;
                            btn.disabled = def.parent ? !core.settings.get(def.parent) : false;
                        }, 1500));
                });
                return withParent(def,
                    el('div', { class: 'clop-setting' }, [btn, ...description(def)]), [btn]);
            }
            console.warn(`[4clopX] setting "${def.key}" has unknown type "${def.type}"`);
            return el('div');
        }

        // Favourites and watch flags form one hierarchy (watched ⊆
        // favourites), so edit them in one stable table rather than two
        // distant sections whose rows mutate each other off-screen.
        function marketEditorSection() {
            const state = {
                expanded: false,
                mode: '',
                view: 'all',
                showDna: false,
                query: '',
                loading: new Set(),
                errors: new Map(),
            };
            let destroyed = false;
            let favouriteInputs = [];
            let watchInputs = [];

            const chevron = el('span', { class: 'clop-chevron' }, ['▸']);
            const content = el('div', { class: 'clop-market-editor-body', style: 'display: none;' });
            const heading = el('button', {
                class: 'btn btn-link clop-market-editor-heading',
                type: 'button',
                'aria-expanded': 'false',
            }, [chevron, ' Favourite and watched markets']);
            const node = el('div', { class: 'clop-market-editor' }, [
                el('div', { class: 'clop-section-heading' }, [heading]),
                content,
            ]);

            const modeButtons = new Map();
            const viewButtons = new Map();
            const tableBox = el('div');
            const search = el('input', {
                class: 'form-control input-sm clop-market-editor-search',
                type: 'search',
                placeholder: 'Filter markets…',
                'aria-label': 'Filter markets',
            });
            const dna = el('input', { type: 'checkbox' });
            const dnaLabel = el('label', { class: 'clop-market-editor-dna' }, [dna, ' Show DNA']);

            function buttonGroup(options, selected, onSelect, label, target) {
                const buttons = options.map(([value, text]) => {
                    const button = el('button', {
                        class: `btn btn-default btn-sm${selected === value ? ' active' : ''}`,
                        type: 'button',
                        'aria-pressed': selected === value ? 'true' : 'false',
                        onclick: () => onSelect(value),
                    }, [text]);
                    target.set(value, button);
                    return button;
                });
                return el('div', { class: 'btn-group', role: 'group', 'aria-label': label }, buttons);
            }

            const modes = buttonGroup(MODE_LABELS, state.mode, (mode) => {
                state.mode = mode;
                refreshControls();
                renderTable();
                ensureCatalog(mode);
            }, 'Market type', modeButtons);
            const views = buttonGroup([
                ['all', 'All markets'],
                ['watch', 'Watch list'],
            ], state.view, (view) => {
                state.view = view;
                refreshControls();
                renderTable();
                ensureCatalog(state.mode);
            }, 'Market editor view', viewButtons);

            search.addEventListener('input', () => {
                state.query = search.value.trim().toLowerCase();
                renderTable();
            });
            dna.addEventListener('change', () => {
                state.showDna = dna.checked;
                renderTable();
            });

            content.appendChild(el('p', { class: 'text-muted' }, [
                '★ controls favourite market tabs; 👁 controls live updates, counts, and notifications. ' +
                'A market must be favourited on that side before it can be watched.',
            ]));
            content.appendChild(el('div', { class: 'clop-market-editor-controls' }, [
                modes,
                views,
                search,
                dnaLabel,
            ]));
            content.appendChild(tableBox);

            function isDna(market) {
                return /^DNA/i.test(market.name || '');
            }

            function favouritesBySide() {
                return {
                    sell: readFavourites('sell', state.mode),
                    buyer: readFavourites('buyer', state.mode),
                };
            }

            function favouriteSets() {
                const bySide = favouritesBySide();
                return {
                    sell: new Set(bySide.sell.map((f) => f.id)),
                    buyer: new Set(bySide.buyer.map((f) => f.id)),
                };
            }

            function catalogReady(mode) {
                const catalog = readMarketCatalog(mode);
                return catalog.length > 0 && catalog.every((market) => market.name);
            }

            function marketsForView() {
                const bySide = favouritesBySide();
                const byId = new Map();
                if (state.view === 'all') {
                    for (const market of readMarketCatalog(state.mode)) byId.set(market.id, market);
                }
                // Preserve removed/server-legacy favourites in the editor so
                // users are never left with a favourite they cannot untick.
                for (const side of ['sell', 'buyer']) {
                    for (const market of bySide[side]) {
                        const known = byId.get(market.id);
                        if (!known || (!known.name && market.name)) byId.set(market.id, market);
                    }
                }
                return sortByResourceOrder(state.mode, [...byId.values()]).filter((market) => {
                    if (!state.showDna && isDna(market)) return false;
                    return !state.query || String(market.name || market.id).toLowerCase().includes(state.query);
                });
            }

            function messageTable(message, retry = false) {
                const children = [message];
                if (retry) {
                    children.push(' ', el('button', {
                        class: 'btn btn-default btn-xs',
                        type: 'button',
                        onclick: () => ensureCatalog(state.mode, true),
                    }, ['Retry']));
                }
                return el('table', { class: 'table table-condensed clop-market-editor-table' }, [
                    el('tbody', {}, [el('tr', {}, [
                        el('td', { class: 'text-muted clop-market-editor-empty' }, children),
                    ])]),
                ]);
            }

            function favouriteCell(market, side) {
                const cb = el('input', { type: 'checkbox' });
                const record = { cb, market, side };
                favouriteInputs.push(record);
                cb.addEventListener('change', () => {
                    setFavourite(side, state.mode, market, cb.checked);
                    if (!cb.checked) forgetMarket(state.mode, side, market.id);
                    core.events.emit('market:favouritesChanged', { mode: state.mode, side });
                    core.events.emit('market:friendlyCache', {});
                    // Newly-added buy favourites are watched by default; let
                    // the leader pick them up without issuing one request per
                    // checkbox during bulk edits.
                    if (cb.checked && core.settings.get('live.enabled')
                        && marketNotifyEnabled(state.mode, side, market.id)) {
                        core.events.emit('live:pollNow', {});
                    }
                });
                return el('td', { title: `Favourite this ${side === 'sell' ? 'sell-order' : 'buy-order'} market` }, [cb]);
            }

            function watchCell(market, side, watchOnly, favs) {
                if (watchOnly && !favs[side].has(market.id)) {
                    return el('td', { class: 'text-muted', title: 'Not a ★ favourite on this side' }, ['—']);
                }
                const cb = el('input', {
                    type: 'checkbox',
                    onchange: (ev) => core.marketNotify.set(state.mode, side, market.id, ev.target.checked),
                });
                watchInputs.push({ cb, market, side });
                return el('td', { title: 'Include in live updates, market counts, and notifications' }, [cb]);
            }

            function renderTable() {
                if (destroyed || !state.expanded) return;
                favouriteInputs = [];
                watchInputs = [];
                tableBox.textContent = '';

                if (state.view === 'all' && !catalogReady(state.mode)) {
                    if (state.loading.has(state.mode)) {
                        tableBox.appendChild(messageTable('Loading market list…'));
                    } else if (state.errors.has(state.mode)) {
                        tableBox.appendChild(messageTable(state.errors.get(state.mode), true));
                    } else {
                        tableBox.appendChild(messageTable('Market list has not been loaded yet…'));
                    }
                    return;
                }

                const markets = marketsForView();
                const favs = favouriteSets();
                const headings = state.view === 'all'
                    ? ['Market', 'Sell ★', 'Sell 👁', 'Buy ★', 'Buy 👁']
                    : ['Market', 'Sell 👁', 'Buy 👁'];
                const tbody = el('tbody');
                for (const market of markets) {
                    const cells = [el('td', {}, [market.name || `resource ${market.id}`])];
                    if (state.view === 'all') {
                        cells.push(
                            favouriteCell(market, 'sell'),
                            watchCell(market, 'sell', false, favs),
                            favouriteCell(market, 'buyer'),
                            watchCell(market, 'buyer', false, favs),
                        );
                    } else {
                        cells.push(
                            watchCell(market, 'sell', true, favs),
                            watchCell(market, 'buyer', true, favs),
                        );
                    }
                    tbody.appendChild(el('tr', {}, cells));
                }
                if (!markets.length) {
                    tbody.appendChild(el('tr', {}, [el('td', {
                        class: 'text-muted clop-market-editor-empty',
                        colspan: String(headings.length),
                    }, [state.view === 'watch'
                        ? 'No favourite markets match these filters.'
                        : 'No markets match these filters.'])]));
                }
                tableBox.appendChild(el('table', { class: 'table table-condensed clop-market-editor-table' }, [
                    el('thead', {}, [el('tr', {}, headings.map((text) => el('th', {}, [text])))]),
                    tbody,
                ]));
                refreshFavouriteInputs();
                refreshWatchInputs();
            }

            function refreshFavouriteInputs() {
                const favs = favouriteSets();
                for (const { cb, market, side } of favouriteInputs) cb.checked = favs[side].has(market.id);
            }

            function refreshWatchInputs() {
                const favs = favouriteSets();
                for (const { cb, market, side } of watchInputs) {
                    const favourite = favs[side].has(market.id);
                    cb.disabled = !favourite;
                    cb.checked = favourite && marketNotifyEnabled(state.mode, side, market.id);
                }
            }

            function refreshControls() {
                for (const [mode, button] of modeButtons) {
                    const selected = mode === state.mode;
                    button.classList.toggle('active', selected);
                    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
                }
                for (const [view, button] of viewButtons) {
                    const selected = view === state.view;
                    button.classList.toggle('active', selected);
                    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
                }
                dna.checked = state.showDna;
                dna.disabled = state.mode !== '';
                dnaLabel.classList.toggle('text-muted', dna.disabled);
                dnaLabel.title = dna.disabled ? 'DNA markets exist only in Resources mode' : '';
            }

            async function ensureCatalog(mode, retry = false) {
                if (destroyed || state.view !== 'all') return;
                if (!retry && catalogReady(mode)) return;
                if (state.loading.has(mode)) return;
                state.loading.add(mode);
                state.errors.delete(mode);
                if (state.mode === mode) renderTable();
                try {
                    const doc = await core.http.getDoc(marketPageUrl('sell', mode));
                    const resources = marketResourcesFromDocument(doc);
                    if (!resources.length) throw new Error('Could not find the market list.');
                    writeMarketCatalog(mode, resources);
                } catch (e) {
                    state.errors.set(mode, `Could not load the market list: ${e.message || e}`);
                } finally {
                    state.loading.delete(mode);
                    if (!destroyed && state.mode === mode) renderTable();
                }
            }

            heading.addEventListener('click', () => {
                state.expanded = !state.expanded;
                heading.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
                chevron.textContent = state.expanded ? '▾' : '▸';
                content.style.display = state.expanded ? '' : 'none';
                if (state.expanded) {
                    refreshControls();
                    renderTable();
                    ensureCatalog(state.mode);
                }
            });

            refreshControls();
            const api = {
                node,
                refreshWatches: refreshWatchInputs,
                refreshFavourites(change) {
                    if (!state.expanded || (change && change.mode !== state.mode)) return;
                    if (state.view === 'watch') renderTable();
                    else {
                        refreshFavouriteInputs();
                        refreshWatchInputs();
                    }
                },
                refreshCatalog(mode) {
                    if (state.expanded && state.view === 'all' && mode === state.mode) renderTable();
                },
                destroy() { destroyed = true; },
            };
            return api;
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
