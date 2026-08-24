// Merged marketplace frontend: one page for both the sell orders
// (marketplace.php listings) and buy orders (buyermarketplace.php offers),
// switched with client-side tabs.  Pure UI — all server communication goes
// through the adapters in ../adapters/market.js, and this file only ever
// handles MarketSnapshot objects.
//
// Both stock pages host the same UI; the URL is kept in sync with the
// active side via history.replaceState so refresh and bookmarks land on the
// same view.

import {
    marketAdapter, kindFromLocation, marketPageUrl, parseToken, parseMode,
    marketIsEmpty, hideStockMarketUi, stockUiInsertionPoint, summarizeFriendly,
} from '../adapters/market.js';
import { fetchResourceStats } from '../adapters/overview.js';
import {
    readFriendlyCache, friendlyTotals, writeFriendlyCacheEntry,
    marketNotifyEnabled, forgetMarket,
} from './liveupdates.js';
import { favouriteIds, writeFavourites, writeResourceOrder } from '../lib/favourites.js';

const SIDES = [
    { side: 'sell', label: 'Sell Orders', hint: 'Listings from sellers — buy from them here.' },
    { side: 'buyer', label: 'Buy Orders', hint: 'Standing offers from buyers — sell to them here.' },
];

export const marketplaceModule = {
    name: 'marketplace',

    matches(page) {
        return page === 'marketplace.php' || page === 'buyermarketplace.php';
    },

    settings(core) {
        core.settings.define({
            key: 'market.sellMaxNegativeNetConfirm',
            label: 'Confirm "Sell Max" when net production is negative',
            description: 'Ask for confirmation before Sell Max empties a stockpile whose per-tick net production is negative (i.e. one you are draining every tick).',
            type: 'bool',
            default: true,
            section: 'Market',
        });
    },

    init(core) {
        if (!parseToken(document)) {
            console.warn('[4clopX] marketplace: no token on page (not logged in?), leaving page alone');
            return;
        }

        const el = core.el.bind(core);
        const mode = parseMode(document);              // '' | 'weapons' | 'armor'
        const hostKind = kindFromLocation(location);

        // Shared instances (the liveupdates module sweeps through the same
        // ones, so the single-use tokens stay coherent within this tab).
        const adapters = {
            sell: marketAdapter(core, 'sell', mode),
            buyer: marketAdapter(core, 'buyer', mode),
        };
        adapters[hostKind].seed(document);

        // Last-visited resource is remembered per side (and per mode), so the
        // sell and buy tabs each restore their own market.
        const lastKey = (side) => `clopx.market.last.${side}.${mode || 'resources'}`;
        const SHOW_DNA_KEY = 'clopx.market.showDna';
        const FAVS_ONLY_KEY = 'clopx.market.favsOnly';

        /* ---------------- state ---------------- */

        const state = {
            side: hostKind,                            // 'sell' | 'buyer'
            activeId: null,
            funds: null,
            mult: { buy: 1, sell: 1 },
            resources: [],
            orders: [],
            messages: { errors: [], infos: [] },
            updatedAt: null,
            busy: false,
            showDna: core.storage.get(SHOW_DNA_KEY, '0') === '1',
            favsOnly: core.storage.get(FAVS_ONLY_KEY, '0') === '1',
            favs: null,                            // {sell: Set, buyer: Set}, filled below
            upkeep: null,                          // resource stats from overview.php
            showHelp: false,
        };

        // Favourites are kept separately per side (and per mode); names are
        // stored alongside ids so other pages can label them.
        state.favs = {
            sell: new Set(favouriteIds('sell', mode)),
            buyer: new Set(favouriteIds('buyer', mode)),
        };
        const favs = () => state.favs[state.side];
        const saveFavs = () => writeFavourites(state.side, mode,
            [...favs()].map((id) => ({ id, name: resourceName(id) })));

        const boot = adapters[hostKind].snapshotFromDocument(document);
        state.funds = boot.funds;
        if (boot.mult) state.mult = boot.mult;
        state.resources = boot.resources;
        state.orders = boot.orders;
        // Cache the server's resource order (used to sort favourite lists,
        // e.g. in the settings panel).
        if (state.resources.length) writeResourceOrder(mode, state.resources.map((r) => r.id));
        if (boot.resourceId) {
            state.activeId = boot.resourceId;
            recordFriendly(hostKind, boot.resourceId, boot.orders);
            if (boot.orders.length || marketIsEmpty(document)) state.updatedAt = new Date();
        } else {
            const remembered = core.storage.get(lastKey(hostKind));
            if (remembered && state.resources.some((r) => r.id === remembered)) state.activeId = remembered;
        }
        // Announce the initial view (merge() keeps this current afterwards).
        if (state.activeId) {
            core.events.emit('market:viewing', {
                mode, side: state.side, resourceId: state.activeId,
                at: state.updatedAt ? Date.now() : 0,
            });
        }

        function resourceName(id) {
            const r = state.resources.find((x) => x.id === id);
            return r ? r.name : 'item';
        }

        function ownedAmount(id) {
            const r = state.resources.find((x) => x.id === id);
            return r ? r.have : 0;
        }

        const isDna = (name) => /^DNA/i.test(name);

        // Visual clarity: button verbs and list prices are bold so they
        // stand out against the auxiliary price info around them.
        const bold = (text) => el('strong', {}, [text]);

        // A sweep in THIS tab ships full snapshots: adopt the open market's
        // in place of a reload of our own (the cycle-end live:polled
        // fallback then stands down).  Badge data lives in the shared cache
        // and is patched via market:friendlyCache — no local copy.
        let adoptedThisCycle = false;
        core.events.on('market:friendly', (d) => {
            if (d.mode !== mode || state.busy) return;
            if (d.snap && d.side === state.side && d.resourceId === state.activeId && !ordersInputPending()) {
                adoptedThisCycle = true;
                if (merge(d.snap, { auto: true })) render();
                else refreshOrdersView();
            }
        });
        core.events.on('market:friendlyCache', () => {
            if (state.busy) return;
            updateBadges();          // watch flags may have changed too
            updateSideTabBadges();
            updateWatchButton();
        });

        // QoL: the open market is effectively watched while it's on screen.
        // In THIS tab's own poll cycles the sweep includes it (watched or
        // ad-hoc) and the snapshot is adopted above; live:polled is the
        // fallback for cycles polled in ANOTHER tab, where only cache
        // summaries — not full snapshots — cross over.  Skipped while an
        // action is in flight, right after an own load (covers the pollNow
        // our own loads trigger), and while an order-row amount field holds
        // typed input, since rebuilding the table would wipe it.
        function ordersInputPending() {
            const ae = document.activeElement;
            if (ae && ordersBox.contains(ae) && ae.tagName === 'INPUT') return true;
            // Amount inputs start empty; anything non-empty is user-typed.
            return [...ordersBox.querySelectorAll('input')].some((i) => i.value !== '');
        }

        core.events.on('live:polled', () => {
            const adopted = adoptedThisCycle;
            adoptedThisCycle = false;
            if (adopted) return;
            if (!state.activeId || state.busy) return;
            if (state.updatedAt && Date.now() - state.updatedAt.getTime() < 5000) return;
            if (ordersInputPending()) return;
            run(() => adapter().load(state.activeId), { auto: true });
        });


        /* ---------------- adapter plumbing ---------------- */

        const adapter = () => adapters[state.side];

        // Record a watched market's friendly orders into the shared cache
        // from a fresh response, so filling an alliance order updates the
        // blue badges, tab title, and other tabs immediately instead of at
        // the next sweep.  (Unwatched markets carry no badges, so there's
        // nothing to record.)
        function recordFriendly(side, resourceId, orders) {
            if (!marketNotifyEnabled(mode, side, resourceId)) return;
            if (writeFriendlyCacheEntry(mode, side, resourceId, summarizeFriendly(orders), resourceName(resourceId))) {
                core.events.emit('market:friendlyCache', {});
            }
        }

        // opts.auto marks a background refresh: the message area is kept
        // unless the response actually carries messages.  Returns whether
        // messages were replaced (the caller then needs a full render).
        function merge(snap, opts) {
            const auto = !!(opts && opts.auto);
            state.orders = snap.orders;
            if (snap.funds) state.funds = snap.funds;
            if (snap.mult) state.mult = snap.mult;
            if (snap.resources.length) state.resources = snap.resources;
            const hasMessages = snap.messages.errors.length > 0 || snap.messages.infos.length > 0;
            const replaceMessages = !auto || hasMessages;
            if (replaceMessages) state.messages = snap.messages;
            if (snap.resourceId) {
                state.activeId = snap.resourceId;
                recordFriendly(snap.kind, snap.resourceId, snap.orders);
                core.storage.set(lastKey(snap.kind), snap.resourceId);
            }
            state.updatedAt = new Date();
            // Tell the live-update engine what this tab is looking at, so
            // its sweeps include the open market (watched or ad-hoc).
            core.events.emit('market:viewing', { mode, side: snap.kind, resourceId: state.activeId, at: Date.now() });
            return replaceMessages;
        }

        async function run(action, opts) {
            const auto = !!(opts && opts.auto);
            if (state.busy) return;
            setBusy(true);
            let fullRender = !auto;
            try {
                if (merge(await action(), opts)) fullRender = true;
            } catch (e) {
                state.messages = { errors: [String(e.message || e)], infos: [] };
                fullRender = true;
            } finally {
                setBusy(false);
                if (fullRender) render();
                else refreshOrdersView();
            }
        }

        const load = (resourceId) => run(() => adapter().load(resourceId));

        // Fresh data on market page load / Refresh / side switch: reload
        // the open market, then ask the live-update engine (ui/liveupdates.js)
        // for a full poll — favourites sweep plus header badges — with a
        // timer reset.  Market pages are the one place where sweeping on
        // load is wanted; everywhere else the engine's own schedule rules.
        const loadAndPoll = (resourceId) => {
            (resourceId ? load(resourceId) : Promise.resolve())
                .then(() => core.events.emit('live:pollNow', {}));
        };

        /* ---------------- upkeep (Sell Max) ----------------
         * "Used" per tick from the Overview Resources table, fetched once
         * when the buy-orders side first becomes active (resources mode
         * only — weapons/armor have no upkeep) and re-verified on every
         * Sell Max click. */

        const upkeepFor = (resourceId) => (state.upkeep
            ? state.upkeep.byName[resourceName(resourceId).toLowerCase()] || null
            : null);

        // The stock to keep back: per-tick upkeep plus the military's
        // 12-hour lump consumption (apples/gems/coffee/gasoline).  The lump
        // is reserved in full — reserving a per-tick average could still
        // starve the military when its deduction lands.
        const reserveOf = (up) => up.used + up.mil;
        const reserveText = (up) => (up.mil
            ? `${core.commas(up.used)}/tick upkeep + ${core.commas(up.mil)} military/12h`
            : `${core.commas(up.used)}/tick upkeep`);

        let upkeepFetching = false;
        async function maybeFetchUpkeep() {
            if (mode || state.upkeep || upkeepFetching) return;
            upkeepFetching = true;
            try {
                state.upkeep = await fetchResourceStats(core);
                updateSellMaxUi();
            } catch (e) {
                console.warn('[4clopX] upkeep fetch failed:', e);
            } finally {
                upkeepFetching = false;
            }
        }

        // Re-fetch the Overview and abort unless upkeep AND the resulting
        // sale amount still match what the button promised (protects against
        // building changes or stock movements in another tab).
        async function sellMax(order, expected, btn) {
            if (state.busy) return;
            setBusy(true);
            btn.textContent = '⟳ Verifying upkeep…';
            const name = resourceName(order.resourceId);
            try {
                const stats = await fetchResourceStats(core);
                state.upkeep = stats;
                const fresh = stats.byName[name.toLowerCase()];
                const freshReserve = fresh ? reserveOf(fresh) : null;
                if (!fresh || freshReserve !== expected.reserve) {
                    state.messages = {
                        errors: [`Not sold: the upkeep of ${name} changed — used to be ${core.commas(expected.reserve)}, ` +
                            `now it's ${fresh ? `${core.commas(freshReserve)} (${reserveText(fresh)})` : 'unknown'}. ` +
                            'Check the numbers and try again if you\'re happy.'],
                        infos: [],
                    };
                    return;
                }
                const freshMax = Math.min(fresh.qty - freshReserve, order.amount);
                if (freshMax !== expected.n) {
                    state.messages = {
                        errors: [`Not sold: your ${name} stock changed — Sell Max would now sell ` +
                            `${core.commas(Math.max(0, freshMax))} instead of ${core.commas(expected.n)}. ` +
                            'Check the numbers and try again if you\'re happy.'],
                        infos: [],
                    };
                    return;
                }
                if (fresh.net < 0 && core.settings.get('market.sellMaxNegativeNetConfirm')) {
                    const ok = window.confirm(
                        `Your net ${name} production is NEGATIVE (${core.commas(fresh.net)}/tick) — ` +
                        'you are draining this stockpile every tick.\n\n' +
                        `Sell ${core.commas(expected.n)} anyway?`);
                    if (!ok) return;
                }
                merge(await adapter().takeOrder(order, String(expected.n)));
            } catch (e) {
                state.messages = { errors: [String(e.message || e)], infos: [] };
            } finally {
                setBusy(false);
                render();
            }
        }

        function switchSide(side) {
            if (state.busy || side === state.side) return;
            state.side = side;
            // Restore this side's own last-visited resource; if it has none
            // yet, carry the current selection over.
            const remembered = core.storage.get(lastKey(side));
            if (remembered && state.resources.some((r) => r.id === remembered)) state.activeId = remembered;
            state.orders = [];
            state.updatedAt = null;
            state.messages = { errors: [], infos: [] };
            // Keep the URL aligned with the stock page for this side.
            try { history.replaceState(null, '', marketPageUrl(side, mode)); } catch (e) { /* ignore */ }
            render();
            if (side === 'buyer') maybeFetchUpkeep();
            loadAndPoll(state.activeId);
        }

        /* ---------------- UI ---------------- */

        core.addStyle(`
            #clop-market-root .clop-side-tabs { margin-bottom: 12px; }
            #clop-market-root .clop-side-tabs > li > a { cursor: pointer; }
            #clop-market-root .clop-tabs { margin: 8px 0; }
            #clop-market-root .clop-tabs > li > a { padding: 4px 10px; cursor: pointer; }
            #clop-market-root .clop-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 12px; margin-bottom: 8px; }
            #clop-market-root .clop-toolbar .clop-spacer { flex: 1; }
            #clop-market-root .clop-place { margin: 8px 0 12px 0; }
            #clop-market-root .clop-place .form-control { width: 110px; display: inline-block; }
            #clop-market-root td { vertical-align: middle !important; }
            #clop-market-root .clop-row-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
            #clop-market-root .clop-row-actions form { margin: 0; display: flex; align-items: center; gap: 6px; }
            #clop-market-root .clop-buyn { width: 150px; }
            #clop-market-root .clop-amount-note { white-space: nowrap; }
            #clop-market-root .clop-tabsbar { display: flex; align-items: flex-start; gap: 10px; }
            #clop-market-root .clop-tabsbar .clop-tabs { flex: 1; }
            #clop-market-root .clop-filter-toggle { white-space: nowrap; font-weight: normal; cursor: pointer; margin: 12px 0 0 0; }
            #clop-market-root .clop-filter-toggle input { margin-right: 4px; }
            #clop-market-root .clop-help { cursor: pointer; margin-top: 12px; }
            #clop-market-root .clop-friendly-badge { margin-left: 6px; }
            #clop-market-root .clop-watch-mark { margin-left: 5px; opacity: .65; font-size: 85%; }
            #clop-market-root .clop-form-row { display: flex; align-items: flex-start; gap: 10px; }
            #clop-market-root .clop-form-row .clop-place { flex: 1; }
            #clop-market-root .clop-form-row > button { margin-top: 8px; white-space: nowrap; }
            #clop-market-root.clop-busy .clop-action { pointer-events: none; opacity: .55; }
            #clop-market-root .clop-updated { font-size: 85%; }
        `);

        const content = document.getElementById('content');
        const root = el('div', { id: 'clop-market-root' });
        // Persistent container for the orders table, so background
        // refreshes can rebuild it without touching the place form or the
        // message area.
        const ordersBox = el('div', { class: 'clop-orders' });

        function multiplierNote() {
            const buyPct = Math.round((state.mult.buy - 1) * 1000) / 10;
            const sellPct = Math.round((1 - state.mult.sell) * 1000) / 10;
            return state.side === 'sell'
                ? `You pay ${buyPct}% over listed prices; you receive ${sellPct}% less when your listings sell.`
                : `You pay ${buyPct}% extra when offering to buy; you receive ${sellPct}% less when selling to an offer.`;
        }

        function render() {
            root.textContent = '';
            root.classList.toggle('clop-busy', state.busy);

            /* side tabs: sell orders vs buy orders, with alliance-order totals */
            root.appendChild(el('ul', { class: 'nav nav-tabs clop-side-tabs' }, SIDES.map(({ side, label, hint }) => {
                const a = el('a', { title: hint, onclick: () => switchSide(side) }, [label]);
                const badge = sideTabBadge(side);
                if (badge) a.appendChild(badge);
                return el('li', {
                    class: state.side === side ? 'active clop-action' : 'clop-action',
                    'data-side': side,
                }, [a]);
            })));

            /* toolbar */
            root.appendChild(el('div', { class: 'well well-sm clop-toolbar' }, [
                el('span', {}, ['Funds: ', el('span', { class: 'text-success clop-funds' }, [state.funds || '?'])]),
                el('span', { class: 'text-muted', title: multiplierNote() }, [
                    `buy ×${state.mult.buy.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}` +
                    ` / sell ×${state.mult.sell.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`,
                ]),
                el('span', { class: 'clop-spacer' }),
                el('span', { class: 'text-muted clop-updated' }, [
                    state.updatedAt ? `updated ${state.updatedAt.toLocaleTimeString()}` : 'not loaded yet',
                ]),
                el('button', {
                    class: 'btn btn-default btn-sm clop-action',
                    type: 'button',
                    onclick: () => {
                        // Partial refresh: reload orders and run a poll, but
                        // leave the place form and message area untouched.
                        if (!state.activeId) { core.events.emit('live:pollNow', {}); return; }
                        run(() => adapter().load(state.activeId), { auto: true })
                            .then(() => core.events.emit('live:pollNow', {}));
                    },
                }, ['⟳ Refresh']),
            ]));

            /* messages from the last response */
            for (const [cls, list] of [['danger', state.messages.errors], ['info', state.messages.infos]]) {
                for (const html of list) {
                    const alert = el('div', { class: `alert alert-${cls} alert-dismissible` });
                    alert.appendChild(el('button', {
                        class: 'close', type: 'button', html: '&times;',
                        onclick: () => alert.remove(),
                    }));
                    alert.appendChild(el('span', { html }));
                    root.appendChild(alert);
                }
            }

            /* resource tabs — the active tab and favourites (DNA included) are
             * always visible; the favourites-only / DNA filters only govern
             * the rest.  Favouriting a DNA market is thus also the way to
             * keep it visible while "show DNA" is off. */
            const hasDna = state.resources.some((r) => isDna(r.name));
            const visible = state.resources.filter((r) => r.id === state.activeId
                || favs().has(r.id)
                || (!state.favsOnly && (state.showDna || !isDna(r.name))));
            const tabs = el('ul', { class: 'nav nav-pills clop-tabs' });
            for (const r of visible) {
                const label = r.have ? `${r.name} (${core.commas(r.have)})` : r.name;
                const a = el('a', { onclick: () => load(r.id) }, [label]);
                const mark = watchMarkFor(r.id);
                if (mark) a.appendChild(mark);
                const badge = badgeFor(r.id);
                if (badge) a.appendChild(badge);
                tabs.appendChild(el('li', {
                    class: r.id === state.activeId ? 'active clop-action' : 'clop-action',
                    'data-rid': r.id,
                }, [a]));
            }
            if (!visible.length) {
                tabs.appendChild(el('li', { class: 'text-muted' }, [
                    el('a', {}, ['No favourite markets yet — open one and hit ☆.']),
                ]));
            }
            const tabsBar = el('div', { class: 'clop-tabsbar' }, [tabs]);
            const favsCb = el('input', {
                type: 'checkbox',
                onchange: (ev) => {
                    state.favsOnly = ev.target.checked;
                    core.storage.set(FAVS_ONLY_KEY, state.favsOnly ? '1' : '0');
                    render();
                },
            });
            favsCb.checked = state.favsOnly;
            tabsBar.appendChild(el('label', { class: 'text-muted clop-filter-toggle' }, [favsCb, ' favourites only']));
            tabsBar.appendChild(el('a', {
                class: 'clop-help clop-action',
                title: 'Favourite markets are re-fetched on refresh to count alliance/friend orders. Click for details.',
                onclick: () => { state.showHelp = !state.showHelp; render(); },
            }, ['(?)']));
            if (hasDna) {
                const dnaCb = el('input', {
                    type: 'checkbox',
                    onchange: (ev) => {
                        state.showDna = ev.target.checked;
                        core.storage.set(SHOW_DNA_KEY, state.showDna ? '1' : '0');
                        render();
                    },
                });
                dnaCb.checked = state.showDna;
                // Kept visible (hiding it would shift the controls around)
                // but inert in favourites-only mode, where favourites are
                // always shown anyway.
                const dnaLabel = el('label', { class: 'text-muted clop-filter-toggle' }, [dnaCb, ' show DNA']);
                if (state.favsOnly) {
                    dnaCb.disabled = true;
                    dnaLabel.title = 'No effect while "favourites only" is on — favourite markets are always shown';
                }
                tabsBar.appendChild(dnaLabel);
            }
            root.appendChild(tabsBar);

            if (state.showHelp) {
                const help = el('div', { class: 'alert alert-info' });
                help.appendChild(el('button', {
                    class: 'close', type: 'button', html: '&times;',
                    onclick: () => { state.showHelp = false; render(); },
                }));
                help.appendChild(el('span', {}, [
                    'Tab badges count the open orders of your alliance mates and friends (the green/blue names) ' +
                    'on this side of the market: 2(68) means two of them are trading 68 units in total. ' +
                    'Badges appear on 👁 watched markets only — pick those in the ⚙ settings from your ★ ' +
                    'favourites (buy orders are watched by default). Watched markets refresh with every live ' +
                    'update, each costing one request per check, so watch sparingly. Everything else refreshes ' +
                    'only when you open its tab — though the open market keeps auto-refreshing while you view it.',
                ]));
                root.appendChild(help);
            }

            if (!state.activeId) {
                root.appendChild(el('div', { class: 'alert alert-info' }, ['Pick a resource above to view its market.']));
                return;
            }

            root.appendChild(el('div', { class: 'clop-form-row' },
                [renderPlaceForm(), watchButton(), favButton()].filter(Boolean)));
            root.appendChild(ordersBox);
            renderOrdersInto();
        }

        function renderOrdersInto() {
            ordersBox.textContent = '';
            ordersBox.appendChild(renderOrders());
        }

        // Background refresh: rebuild the orders table and patch the funds
        // and "updated" stamps in place — the place form and message area
        // stay untouched.
        function refreshOrdersView() {
            renderOrdersInto();
            const funds = root.querySelector('.clop-funds');
            if (funds) funds.textContent = state.funds || '?';
            const updated = root.querySelector('.clop-updated');
            if (updated) {
                updated.textContent = state.updatedAt
                    ? `updated ${state.updatedAt.toLocaleTimeString()}`
                    : 'not loaded yet';
            }
            updateBadges();
            updateSideTabBadges();
        }

        // Watched markets carry a persistent indicator — a badge alone can't
        // signal watching, since zero-order badges are hidden.
        function watchMarkFor(id) {
            if (!marketNotifyEnabled(mode, state.side, id)) return null;
            return el('span', {
                class: 'clop-watch-mark',
                title: 'Watched: refreshes with every live update and can notify (change in ⚙ settings)',
            }, ['👁']);
        }

        // [orders (total)] alliance/friend badge for a tab, straight from
        // the shared cache — which holds exactly the watched markets, so
        // every badge shown contributes to the header/menu totals.
        function badgeFor(id) {
            const f = readFriendlyCache()[`${mode || 'resources'}|${state.side}|${id}`];
            if (!f || !f.count) return null;
            const what = state.side === 'sell' ? 'selling' : 'buying';
            return el('span', {
                class: 'badge clop-friendly-badge',
                title: `${f.count} alliance/friend order${f.count === 1 ? '' : 's'} ${what} ${core.commas(f.amount)} total`,
            }, [`${f.count} (${core.commas(f.amount)})`]);
        }

        // Alliance-order total across this side's watched favourites (with
        // the defaults, that's buy orders only — sell markets show up here
        // once watched via the settings panel).
        function sideTabBadge(side) {
            const t = friendlyTotals(mode, side);
            if (!t.orders) return null;
            return el('span', {
                class: 'badge clop-menu-badge',
                title: `${t.orders} alliance/friend order${t.orders === 1 ? '' : 's'} ` +
                    `(${core.commas(t.amount)} units) across your favourite markets`,
            }, [String(t.orders)]);
        }

        function updateSideTabBadges() {
            for (const li of root.querySelectorAll('.clop-side-tabs li[data-side]')) {
                const a = li.querySelector('a');
                const old = a.querySelector('.clop-menu-badge');
                if (old) old.remove();
                const badge = sideTabBadge(li.getAttribute('data-side'));
                if (badge) a.appendChild(badge);
            }
        }

        // Patch badges and watch marks into the existing tabs without a
        // full render — a render mid-sweep would wipe whatever the user is
        // typing.
        function updateBadges() {
            for (const li of root.querySelectorAll('.clop-tabs li[data-rid]')) {
                const id = li.getAttribute('data-rid');
                const a = li.querySelector('a');
                for (const old of a.querySelectorAll('.clop-watch-mark, .clop-friendly-badge')) old.remove();
                const mark = watchMarkFor(id);
                if (mark) a.appendChild(mark);
                const badge = badgeFor(id);
                if (badge) a.appendChild(badge);
            }
        }

        function favButton() {
            const fav = favs().has(state.activeId);
            return el('button', {
                class: `btn btn-sm ${fav ? 'btn-warning' : 'btn-default'} clop-action`,
                type: 'button',
                title: fav
                    ? 'Stop counting alliance/friend orders for this market'
                    : 'Count alliance/friend orders for this market on every load and refresh',
                onclick: () => {
                    if (fav) favs().delete(state.activeId);
                    else favs().add(state.activeId);
                    saveFavs();
                    if (fav) {
                        // Unfavourite = forget: drop the watch override and
                        // cached counts so totals adjust immediately and a
                        // re-favourite starts from the side defaults.
                        forgetMarket(mode, state.side, state.activeId);
                        core.events.emit('market:friendlyCache', {});
                    } else {
                        // A fresh favourite may be watched by default (buy
                        // side): seed the cache from the open market's data.
                        recordFriendly(state.side, state.activeId, state.orders);
                    }
                    render();
                },
            }, [fav ? '★ Unfavourite Market' : '☆ Favourite Market']);
        }

        // Inline watch toggle, left of the ★ button — quick per-market
        // control; the settings panel is the centralised overview.  Only
        // rendered for favourites: its absence reinforces that only ★
        // favourites can be watched, discoverability is covered by
        // buy-side favourites being watched by default, and sitting on the
        // LEFT means appearing/disappearing shifts no other element.
        function watchButton() {
            if (!favs().has(state.activeId)) return null;
            const watched = marketNotifyEnabled(mode, state.side, state.activeId);
            return el('button', {
                class: `btn btn-sm ${watched ? 'btn-info' : 'btn-default'} clop-action clop-watch-btn`,
                type: 'button',
                title: watched
                    ? 'Stop auto-refreshing this market with live updates'
                    : 'Auto-refresh this market with live updates, count it in the blue badges, and notify on new alliance orders',
                onclick: () => {
                    core.marketNotify.set(mode, state.side, state.activeId, !watched);
                    render();
                },
            }, [watched ? '👁 Unwatch' : '👁 Watch']);
        }

        // Patch the inline watch button when flags change without a full
        // render (e.g. toggled from the settings panel, possibly in another
        // tab).  The appear-from-nothing case only follows favouriting,
        // which renders anyway.
        function updateWatchButton() {
            const old = root.querySelector('.clop-watch-btn');
            if (!old) return;
            const fresh = watchButton();
            if (fresh) old.replaceWith(fresh);
            else old.remove();
        }

        /* list / offer form for the active resource */
        function renderPlaceForm() {
            const sell = state.side === 'sell';
            const qty = el('input', { class: 'form-control', placeholder: 'Qty' });
            const price = el('input', { class: 'form-control', placeholder: 'Bits each' });
            const note = el('span', { class: 'text-muted' });

            const updateNote = () => {
                const q = parseInt(qty.value, 10), p = parseInt(price.value, 10);
                if (!(q > 0) || !(p > 0)) { note.textContent = ''; return; }
                note.textContent = sell
                    ? ` — ${core.commas(Math.floor(p * q * state.mult.sell))} bits if it all sells`
                    : ` — costs ${core.commas(Math.floor(p * q * state.mult.buy))} bits now (refunded if you remove the offer)`;
            };
            qty.addEventListener('input', updateNote);
            price.addEventListener('input', updateNote);

            return el('form', {
                class: 'form-inline clop-place clop-action',
                onsubmit: (ev) => {
                    ev.preventDefault();
                    if (!/^\d+$/.test(qty.value.trim()) || !/^\d+$/.test(price.value.trim())) {
                        state.messages = { errors: ['Digits only- no commas, periods, or other markers.'], infos: [] };
                        render();
                        return;
                    }
                    run(() => adapter().createOrder(state.activeId, qty.value.trim(), price.value.trim()));
                },
            }, [
                sell ? 'Place ' : 'Offer to buy ',
                qty,
                ` ${resourceName(state.activeId)} at `,
                price,
                ' ',
                el('button', { class: `btn ${sell ? 'btn-success' : 'btn-info'}`, type: 'submit' }, [
                    sell ? 'Place on Market' : 'Offer to Buy',
                ]),
                note,
            ]);
        }

        function renderOrders() {
            if (!state.orders.length) {
                const msg = state.updatedAt
                    ? (state.side === 'sell' ? 'That item is not on the market.' : 'Nobody wants to buy that item.')
                    : 'Not loaded yet — hit Refresh.';
                return el('div', { class: 'alert alert-warning' }, [msg]);
            }

            const thead = el('thead', {}, [el('tr', {}, (
                state.side === 'sell'
                    ? ['Unit Price', 'Units Available', 'Seller', 'Actions']
                    : ['Offering', 'Amount Wanted', 'Buyer', 'Actions']
            ).map((h) => el('th', {}, [h])))]);

            const tbody = el('tbody');
            state.orders.forEach((order, idx) => tbody.appendChild(renderOrderRow(order, idx)));

            return el('table', { class: 'table table-striped table-bordered table-condensed' }, [thead, tbody]);
        }

        function renderOrderRow(order, idx) {
            const sell = state.side === 'sell';
            const priceCell = el('td', {}, [el('span', { class: 'text-danger' }, [bold(core.commas(order.price))])]);
            const unit = (mult) => core.commas(Math.floor(order.price * mult));
            const total = (mult) => core.commas(Math.floor(order.price * order.amount * mult));
            let hint;
            if (order.own) {
                // Your own listing/offer: what selling out earns you, or
                // what your standing offer costs you (already escrowed).
                hint = sell
                    ? `you get ${unit(state.mult.sell)} ea. / ${total(state.mult.sell)} for all`
                    : `you pay ${unit(state.mult.buy)} ea. / ${total(state.mult.buy)} for all (escrowed)`;
            } else {
                hint = sell
                    ? `you pay ${unit(state.mult.buy)} ea.`
                    : `you get ${unit(state.mult.sell)} ea.`;
            }
            priceCell.appendChild(el('div', {}, [el('small', { class: 'text-muted' }, [hint])]));

            const actions = el('div', { class: 'clop-row-actions clop-action' });
            if (order.own) {
                actions.appendChild(el('button', {
                    class: 'btn btn-danger btn-sm', type: 'button',
                    onclick: () => run(() => adapter().cancelOrder(order)),
                }, ['Remove from Marketplace']));
            } else if (sell) {
                actions.appendChild(el('button', {
                    class: 'btn btn-primary btn-sm', type: 'button',
                    onclick: () => run(() => adapter().takeOrder(order, 'one')),
                }, [bold('Buy One')]));
                actions.appendChild(el('button', {
                    class: 'btn btn-warning btn-sm', type: 'button',
                    onclick: () => run(() => adapter().takeOrder(order, 'all')),
                }, [bold('Buy All'), ` (${total(state.mult.buy)} bits)`]));
                actions.appendChild(amountForm('Buy:', 'btn-success',
                    (n) => run(() => adapter().takeOrder(order, n)),
                    (n) => `pay ${core.commas(Math.floor(order.price * n * state.mult.buy))} bits`));
            } else {
                actions.appendChild(el('button', {
                    class: 'btn btn-primary btn-sm', type: 'button',
                    onclick: () => run(() => adapter().takeOrder(order, 'one')),
                }, [bold('Sell One')]));
                actions.appendChild(sellButton(order));
                actions.appendChild(amountForm('Sell:', 'btn-success',
                    (n) => run(() => adapter().takeOrder(order, n)),
                    (n) => `get ${core.commas(Math.floor(order.price * n * state.mult.sell))} bits`));
            }

            return el('tr', { 'data-idx': String(idx) }, [
                priceCell,
                el('td', {}, [el('span', { class: 'text-success' }, [core.commas(order.amount)])]),
                el('td', { html: order.ownerHtml }),
                el('td', {}, [actions]),
            ]);
        }

        // Combined Sell All / Sell Max button — one slot, never both.
        // Orange "Sell All" when your spare stock (owned − reserve) covers
        // the whole order; blue "Sell Max" selling just the spare when it
        // doesn't — the color and the "(N: …)" amount against the visible
        // "Amount Wanted" column signal a partial fill, and the tooltip
        // spells it out.  Weapons/armor (no upkeep concept) and resources
        // missing from the Overview keep plain Sell All behavior.
        function sellButton(order) {
            const have = ownedAmount(order.resourceId);
            const allBits = core.commas(Math.floor(order.price * order.amount * state.mult.sell));
            const sellAll = () => el('button', {
                class: 'btn btn-warning btn-sm clop-sellbtn', type: 'button',
                onclick: () => run(() => adapter().takeOrder(order, 'all')),
            }, [bold('Sell All'), ` (${allBits} bits)`]);

            const up = mode ? null : upkeepFor(order.resourceId);
            if (mode || (state.upkeep && !up)) {
                const btn = sellAll();
                if (!mode) btn.title = 'No upkeep data for this resource on the Overview page — reserving nothing';
                if (have < order.amount) {
                    btn.disabled = true;
                    btn.title = `You only have ${core.commas(have)}`;
                }
                return btn;
            }
            if (!up) {
                // Overview fetch still in flight.
                const btn = el('button', { class: 'btn btn-warning btn-sm clop-sellbtn', type: 'button' },
                    [bold('Sell All'), ' (…)']);
                btn.disabled = true;
                btn.title = 'Checking your upkeep on the Overview page…';
                return btn;
            }

            const reserve = reserveOf(up);
            const spare = have - reserve;
            if (spare >= order.amount) {
                const btn = sellAll();
                btn.title = `Fills the whole order and leaves your reserve of ${core.commas(reserve)} ` +
                    `(${reserveText(up)}) untouched`;
                return btn;
            }
            if (spare < 1) {
                const btn = el('button', { class: 'btn btn-info btn-sm clop-sellbtn', type: 'button' }, [bold('Sell Max')]);
                btn.disabled = true;
                btn.title = `Nothing to spare: you have ${core.commas(have)} and keep ` +
                    `${core.commas(reserve)} back (${reserveText(up)})`;
                return btn;
            }
            const btn = el('button', { class: 'btn btn-info btn-sm clop-sellbtn', type: 'button' }, [
                bold('Sell Max'),
                ` (${core.commas(spare)}: ${core.commas(Math.floor(order.price * spare * state.mult.sell))} bits)`,
            ]);
            btn.title = `Fills only ${core.commas(spare)} of the ${core.commas(order.amount)} wanted — the rest of ` +
                `your ${core.commas(have)} is your reserve (${reserveText(up)}); upkeep is re-verified before selling`;
            btn.addEventListener('click', () => sellMax(order, { reserve, n: spare }, btn));
            return btn;
        }

        // Patch the sell button in place once upkeep data arrives — a full
        // render here could wipe what the user is typing.
        function updateSellMaxUi() {
            if (state.side !== 'buyer' || mode) return;
            for (const tr of root.querySelectorAll('tr[data-idx]')) {
                const order = state.orders[Number(tr.getAttribute('data-idx'))];
                if (!order || order.own) continue;
                const old = tr.querySelector('.clop-sellbtn');
                if (old) old.replaceWith(sellButton(order));
            }
        }

        function amountForm(label, btnClass, onAmount, preview) {
            const input = el('input', { class: 'form-control input-sm', type: 'text', placeholder: 'Qty' });
            const note = el('small', { class: 'text-muted clop-amount-note' });
            const updateNote = () => {
                const n = parseInt(input.value, 10);
                note.textContent = (preview && /^\d+$/.test(input.value.trim()) && n > 0) ? preview(n) : '';
            };
            input.addEventListener('input', updateNote);
            updateNote();
            return el('form', {
                onsubmit: (ev) => {
                    ev.preventDefault();
                    if (!/^\d+$/.test(input.value.trim())) return;
                    onAmount(input.value.trim());
                },
            }, [
                el('div', { class: 'input-group input-group-sm clop-buyn' }, [
                    el('span', { class: 'input-group-btn' }, [
                        el('button', { class: `btn btn-sm ${btnClass}`, type: 'submit' }, [bold(label)]),
                    ]),
                    input,
                ]),
                note,
            ]);
        }

        function setBusy(b) {
            state.busy = b;
            root.classList.toggle('clop-busy', b);
        }

        /* ---------------- go ---------------- */

        hideStockMarketUi(content);
        content.insertBefore(root, stockUiInsertionPoint(content));
        render();

        // Orders only come with POST responses, so a remembered resource has
        // nothing rendered yet — load it dynamically, then run a full poll.
        if (state.side === 'buyer') maybeFetchUpkeep();
        if (state.activeId && !state.updatedAt) loadAndPoll(state.activeId);
        else core.events.emit('live:pollNow', {});
    },
};
