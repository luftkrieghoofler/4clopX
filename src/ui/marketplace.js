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
    createMarketAdapter, kindFromLocation, marketPageUrl, parseToken, parseMode,
    marketIsEmpty, hideStockMarketUi, stockUiInsertionPoint,
} from '../adapters/market.js';
import { fetchResourceStats } from '../adapters/overview.js';

const SIDES = [
    { side: 'sell', label: 'Sell Orders', hint: 'Listings from sellers — buy from them here.' },
    { side: 'buyer', label: 'Buy Orders', hint: 'Standing offers from buyers — sell to them here.' },
];

export const marketplaceModule = {
    name: 'marketplace',

    matches(page) {
        return page === 'marketplace.php' || page === 'buyermarketplace.php';
    },

    init(core) {
        if (!parseToken(document)) {
            console.warn('[CLOP-US] marketplace: no token on page (not logged in?), leaving page alone');
            return;
        }

        const el = core.el.bind(core);
        const mode = parseMode(document);              // '' | 'weapons' | 'armor'
        const hostKind = kindFromLocation(location);

        core.settings.define({
            key: 'market.sellMaxNegativeNetConfirm',
            label: 'Confirm "Sell Max" when net production is negative',
            description: 'Ask for confirmation before Sell Max empties a stockpile whose per-tick net production is negative (i.e. one you are draining every tick).',
            type: 'bool',
            default: true,
        });

        const adapters = {
            sell: createMarketAdapter(core, 'sell', mode, hostKind === 'sell' ? document : null),
            buyer: createMarketAdapter(core, 'buyer', mode, hostKind === 'buyer' ? document : null),
        };

        // Last-visited resource is remembered per side (and per mode), so the
        // sell and buy tabs each restore their own market.
        const lastKey = (side) => `clopus.market.last.${side}.${mode || 'resources'}`;
        const SHOW_DNA_KEY = 'clopus.market.showDna';
        const FAVS_KEY = `clopus.market.favs.${mode || 'resources'}`;
        const FAVS_ONLY_KEY = 'clopus.market.favsOnly';

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
            favs: new Set(),
            friendly: { sell: {}, buyer: {} },     // resourceId -> {amount, count}
            upkeep: null,                          // resource stats from overview.php
            showHelp: false,
        };

        try { state.favs = new Set(JSON.parse(core.storage.get(FAVS_KEY, '[]'))); } catch (e) { /* corrupt value */ }
        const saveFavs = () => core.storage.set(FAVS_KEY, JSON.stringify([...state.favs]));

        const boot = adapters[hostKind].snapshotFromDocument(document);
        state.funds = boot.funds;
        if (boot.mult) state.mult = boot.mult;
        state.resources = boot.resources;
        state.orders = boot.orders;
        if (boot.resourceId) {
            state.activeId = boot.resourceId;
            state.friendly[hostKind][boot.resourceId] = summarizeFriendly(boot.orders);
            if (boot.orders.length || marketIsEmpty(document)) state.updatedAt = new Date();
        } else {
            const remembered = core.storage.get(lastKey(hostKind));
            if (remembered && state.resources.some((r) => r.id === remembered)) state.activeId = remembered;
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

        // Orders from alliance mates (green) or friends (blue), per the
        // server's own styling; own orders excluded.  (Friend styling
        // overrides alliance styling server-side, which is why both count.)
        function summarizeFriendly(orders) {
            let amount = 0, count = 0;
            for (const o of orders) {
                if (!o.own && (o.relation === 'alliance' || o.relation === 'friend')) {
                    amount += o.amount;
                    count += 1;
                }
            }
            return { amount, count };
        }

        /* ---------------- adapter plumbing ---------------- */

        const adapter = () => adapters[state.side];

        function merge(snap) {
            state.orders = snap.orders;
            if (snap.funds) state.funds = snap.funds;
            if (snap.mult) state.mult = snap.mult;
            if (snap.resources.length) state.resources = snap.resources;
            state.messages = snap.messages;
            if (snap.resourceId) {
                state.activeId = snap.resourceId;
                state.friendly[snap.kind][snap.resourceId] = summarizeFriendly(snap.orders);
                core.storage.set(lastKey(snap.kind), snap.resourceId);
            }
            state.updatedAt = new Date();
        }

        async function run(action) {
            if (state.busy) return;
            setBusy(true);
            try {
                merge(await action());
            } catch (e) {
                state.messages = { errors: [String(e.message || e)], infos: [] };
            } finally {
                setBusy(false);
                render();
            }
        }

        const load = (resourceId) => run(() => adapter().load(resourceId));

        // Refresh the alliance/friend badge counts for all favourite markets
        // on the current side — one POST per favourite (the open market is
        // skipped; its counts come with every regular response).  There is
        // deliberately no caching: this runs on boot, Refresh, and side
        // switches only — a market tab click refreshes just the clicked
        // market's own badge — and a newer sweep or a side switch aborts an
        // older one.
        let sweepSeq = 0;
        async function sweepFavourites() {
            const seq = ++sweepSeq;
            const side = state.side;
            const targets = [...state.favs]
                .filter((id) => id !== state.activeId && state.resources.some((r) => r.id === id));
            for (const id of targets) {
                if (seq !== sweepSeq || state.side !== side) return; // superseded
                try {
                    const snap = await adapters[side].load(id);
                    state.friendly[side][id] = summarizeFriendly(snap.orders);
                    if (snap.resources.length) state.resources = snap.resources;
                    updateBadges();
                } catch (e) {
                    console.warn('[CLOP-US] favourites sweep stopped:', e);
                    return;
                }
            }
        }

        const loadAndSweep = (resourceId) => {
            if (resourceId) load(resourceId).then(sweepFavourites);
            else sweepFavourites();
        };

        /* ---------------- upkeep (Sell Max) ----------------
         * "Used" per tick from the Overview Resources table, fetched once
         * when the buy-orders side first becomes active (resources mode
         * only — weapons/armor have no upkeep) and re-verified on every
         * Sell Max click. */

        const upkeepFor = (resourceId) => (state.upkeep
            ? state.upkeep.byName[resourceName(resourceId).toLowerCase()] || null
            : null);

        let upkeepFetching = false;
        async function maybeFetchUpkeep() {
            if (mode || state.upkeep || upkeepFetching) return;
            upkeepFetching = true;
            try {
                state.upkeep = await fetchResourceStats(core);
                updateSellMaxUi();
            } catch (e) {
                console.warn('[CLOP-US] upkeep fetch failed:', e);
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
                if (!fresh || fresh.used !== expected.used) {
                    state.messages = {
                        errors: [`Not sold: the upkeep of ${name} changed — used to be ${core.commas(expected.used)}, ` +
                            `now it's ${fresh ? core.commas(fresh.used) : 'unknown'}. Check the numbers and try again if you're happy.`],
                        infos: [],
                    };
                    return;
                }
                const freshMax = Math.min(fresh.qty - fresh.used, order.amount);
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
            loadAndSweep(state.activeId);
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
            #clop-market-root .clop-form-row { display: flex; align-items: flex-start; gap: 10px; }
            #clop-market-root .clop-form-row .clop-place { flex: 1; }
            #clop-market-root .clop-form-row > button { margin-top: 8px; white-space: nowrap; }
            #clop-market-root.clop-busy .clop-action { pointer-events: none; opacity: .55; }
            #clop-market-root .clop-updated { font-size: 85%; }
        `);

        const content = document.getElementById('content');
        const root = el('div', { id: 'clop-market-root' });

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

            /* side tabs: sell orders vs buy orders */
            root.appendChild(el('ul', { class: 'nav nav-tabs clop-side-tabs' }, SIDES.map(({ side, label, hint }) =>
                el('li', { class: state.side === side ? 'active clop-action' : 'clop-action' }, [
                    el('a', { title: hint, onclick: () => switchSide(side) }, [label]),
                ]))));

            /* toolbar */
            root.appendChild(el('div', { class: 'well well-sm clop-toolbar' }, [
                el('span', {}, ['Funds: ', el('span', { class: 'text-success' }, [state.funds || '?'])]),
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
                    onclick: () => loadAndSweep(state.activeId),
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
             * the rest */
            const hasDna = state.resources.some((r) => isDna(r.name));
            const visible = state.resources.filter((r) => r.id === state.activeId
                || state.favs.has(r.id)
                || (!state.favsOnly && (state.showDna || !isDna(r.name))));
            const tabs = el('ul', { class: 'nav nav-pills clop-tabs' });
            for (const r of visible) {
                const label = r.have ? `${r.name} (${core.commas(r.have)})` : r.name;
                const a = el('a', { onclick: () => load(r.id) }, [label]);
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
            if (!state.favsOnly && hasDna) {
                const dnaCb = el('input', {
                    type: 'checkbox',
                    onchange: (ev) => {
                        state.showDna = ev.target.checked;
                        core.storage.set(SHOW_DNA_KEY, state.showDna ? '1' : '0');
                        render();
                    },
                });
                dnaCb.checked = state.showDna;
                tabsBar.appendChild(el('label', { class: 'text-muted clop-filter-toggle' }, [dnaCb, ' show DNA']));
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
                    'on this side of the market: 68(2) means two of them are trading 68 units in total. ' +
                    'Only ★ favourite markets and the currently open one are counted. Each favourite costs one ' +
                    'extra server request on every load and view change, so try not to spam the server.',
                ]));
                root.appendChild(help);
            }

            if (!state.activeId) {
                root.appendChild(el('div', { class: 'alert alert-info' }, ['Pick a resource above to view its market.']));
                return;
            }

            root.appendChild(el('div', { class: 'clop-form-row' }, [renderPlaceForm(), favButton()]));
            root.appendChild(renderOrders());
        }

        // [total(orders)] alliance/friend badge for a tab — favourites and
        // the open market only.
        function badgeFor(id) {
            if (id !== state.activeId && !state.favs.has(id)) return null;
            const f = state.friendly[state.side][id];
            if (!f || !f.count) return null;
            const what = state.side === 'sell' ? 'selling' : 'buying';
            return el('span', {
                class: 'badge clop-friendly-badge',
                title: `${f.count} alliance/friend order${f.count === 1 ? '' : 's'} ${what} ${core.commas(f.amount)} total`,
            }, [`${core.commas(f.amount)} (${f.count})`]);
        }

        // Patch badges into the existing tabs without a full render — a
        // render mid-sweep would wipe whatever the user is typing.
        function updateBadges() {
            for (const li of root.querySelectorAll('.clop-tabs li[data-rid]')) {
                const a = li.querySelector('a');
                const old = a.querySelector('.clop-friendly-badge');
                if (old) old.remove();
                const badge = badgeFor(li.getAttribute('data-rid'));
                if (badge) a.appendChild(badge);
            }
        }

        function favButton() {
            const fav = state.favs.has(state.activeId);
            return el('button', {
                class: `btn btn-sm ${fav ? 'btn-warning' : 'btn-default'} clop-action`,
                type: 'button',
                title: fav
                    ? 'Stop counting alliance/friend orders for this market'
                    : 'Count alliance/friend orders for this market on every load and refresh',
                onclick: () => {
                    if (fav) state.favs.delete(state.activeId);
                    else state.favs.add(state.activeId);
                    saveFavs();
                    render();
                },
            }, [fav ? '★ Unfavourite Market' : '☆ Favourite Market']);
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
            const priceCell = el('td', {}, [el('span', { class: 'text-danger' }, [core.commas(order.price)])]);
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
                }, ['Buy One']));
                actions.appendChild(el('button', {
                    class: 'btn btn-warning btn-sm', type: 'button',
                    onclick: () => run(() => adapter().takeOrder(order, 'all')),
                }, [`Buy All (${total(state.mult.buy)} bits)`]));
                actions.appendChild(amountForm('Buy:', 'btn-success',
                    (n) => run(() => adapter().takeOrder(order, n)),
                    (n) => `pay ${core.commas(Math.floor(order.price * n * state.mult.buy))} bits`));
            } else {
                actions.appendChild(el('button', {
                    class: 'btn btn-primary btn-sm', type: 'button',
                    onclick: () => run(() => adapter().takeOrder(order, 'one')),
                }, ['Sell One']));
                actions.appendChild(sellAllButton(order));
                if (!mode) actions.appendChild(sellMaxButton(order));
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

        // Sell All / Sell Max are mutually exclusive: Sell All is for filling
        // the whole order without touching upkeep, Sell Max for selling all
        // spare stock (have − used) when that's less than the order.  When
        // the spare stock exactly equals the order, both are enabled (they
        // are equivalent).
        function sellAllButton(order) {
            const have = ownedAmount(order.resourceId);
            const up = upkeepFor(order.resourceId);
            const bits = Math.floor(order.price * order.amount * state.mult.sell);
            const btn = el('button', {
                class: 'btn btn-warning btn-sm clop-sellall', type: 'button',
                onclick: () => run(() => adapter().takeOrder(order, 'all')),
            }, [`Sell All (${core.commas(bits)} bits)`]);
            if (have < order.amount) {
                btn.disabled = true;
                btn.title = `You only have ${core.commas(have)}`;
            } else if (up && have - up.used < order.amount) {
                btn.disabled = true;
                btn.title = `Selling all ${core.commas(order.amount)} would eat into your ` +
                    `${core.commas(up.used)}/tick upkeep — use Sell Max`;
            }
            return btn;
        }

        function sellMaxButton(order) {
            const have = ownedAmount(order.resourceId);
            const up = upkeepFor(order.resourceId);
            const btn = el('button', { class: 'btn btn-info btn-sm clop-sellmax', type: 'button' }, []);
            if (!up) {
                btn.textContent = 'Sell Max (…)';
                btn.disabled = true;
                btn.title = state.upkeep
                    ? 'No upkeep data for this resource on the Overview page'
                    : 'Fetching upkeep from the Overview page…';
                return btn;
            }
            const max = Math.min(have - up.used, order.amount);
            if (max < 1) {
                btn.textContent = 'Sell Max';
                btn.disabled = true;
                btn.title = `Nothing to spare: you have ${core.commas(have)} and use ${core.commas(up.used)}/tick`;
            } else if (have - up.used > order.amount) {
                btn.textContent = `Sell Max (${core.commas(max)}: ` +
                    `${core.commas(Math.floor(order.price * max * state.mult.sell))} bits)`;
                btn.disabled = true;
                btn.title = `You can spare ${core.commas(have - up.used)} — more than this whole order; use Sell All`;
            } else {
                btn.textContent = `Sell Max (${core.commas(max)}: ` +
                    `${core.commas(Math.floor(order.price * max * state.mult.sell))} bits)`;
                btn.title = `Sell everything above your ${core.commas(up.used)}/tick upkeep ` +
                    `(${core.commas(have)} − ${core.commas(up.used)}); upkeep is re-verified before selling`;
                btn.addEventListener('click', () => sellMax(order, { used: up.used, n: max }, btn));
            }
            return btn;
        }

        // Patch the Sell All / Sell Max buttons in place once upkeep data
        // arrives — a full render here could wipe what the user is typing.
        function updateSellMaxUi() {
            if (state.side !== 'buyer' || mode) return;
            for (const tr of root.querySelectorAll('tr[data-idx]')) {
                const order = state.orders[Number(tr.getAttribute('data-idx'))];
                if (!order || order.own) continue;
                const oldAll = tr.querySelector('.clop-sellall');
                if (oldAll) oldAll.replaceWith(sellAllButton(order));
                const oldMax = tr.querySelector('.clop-sellmax');
                if (oldMax) oldMax.replaceWith(sellMaxButton(order));
            }
        }

        function amountForm(label, btnClass, onAmount, preview) {
            const input = el('input', { class: 'form-control input-sm', value: '1', type: 'text' });
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
                        el('button', { class: `btn btn-sm ${btnClass}`, type: 'submit' }, [label]),
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
        // nothing rendered yet — load it dynamically, then sweep favourites.
        if (state.side === 'buyer') maybeFetchUpkeep();
        if (state.activeId && !state.updatedAt) loadAndSweep(state.activeId);
        else sweepFavourites();
    },
};
