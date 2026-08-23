// ==UserScript==
// @name         CLOP Dynamic UI
// @namespace    clop-userscript
// @version      0.2.0
// @description  Modular client-side UI replacement for CLOP. Module 1: dynamic marketplace / buyer's marketplace.
// @match        https://4clop.org/*
// @match        https://*.4clop.org/*
// @match        http://localhost/*
// @match        https://localhost/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* =====================================================================
     * Core
     *
     * Small framework so that individual pieces of the old UI can be
     * replaced one module at a time.  A module is:
     *
     *   {
     *     name:    'marketplace',
     *     matches: (page, location) => bool,   // page = basename of pathname
     *     init:    (core) => void,
     *   }
     *
     * Core provides a serialized HTTP queue (the game's single-use tokens
     * make concurrent POSTs impossible), an HTML response parser, and a few
     * DOM helpers.
     * ===================================================================== */

    const Core = {
        version: '0.2.0',
        modules: [],

        register(mod) {
            this.modules.push(mod);
        },

        boot() {
            const page = location.pathname.replace(/^.*\//, '');
            for (const mod of this.modules) {
                let use = false;
                try { use = mod.matches(page, location); } catch (e) { /* ignore */ }
                if (!use) continue;
                try {
                    mod.init(this);
                    console.info(`[CLOP-US] module "${mod.name}" active`);
                } catch (e) {
                    console.error(`[CLOP-US] module "${mod.name}" failed to init:`, e);
                }
            }
        },

        /* ---------------- HTTP (serialized) ---------------- */

        http: {
            _chain: Promise.resolve(),

            // POST form-encoded params, return the response parsed as a
            // Document.  Calls are strictly serialized: the backend token is
            // single-use and rotates on every POST, so two in-flight requests
            // would invalidate each other.
            postForm(url, params) {
                const run = () => fetch(url, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams(params).toString(),
                }).then((r) => {
                    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
                    return r.text();
                }).then((text) => new DOMParser().parseFromString(text, 'text/html'));

                const p = this._chain.then(run, run);
                this._chain = p.then(() => {}, () => {}); // keep queue alive on errors
                return p;
            },
        },

        /* ---------------- DOM helpers ---------------- */

        el(tag, attrs, children) {
            const node = document.createElement(tag);
            for (const [k, v] of Object.entries(attrs || {})) {
                if (k === 'class') node.className = v;
                else if (k === 'html') node.innerHTML = v;
                else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
                else node.setAttribute(k, v);
            }
            for (const child of children || []) {
                node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
            }
            return node;
        },

        addStyle(css) {
            document.head.appendChild(this.el('style', { html: css }));
        },

        commas(n) {
            return Number(n).toLocaleString('en-US');
        },
    };

    /* =====================================================================
     * Module: marketplace + buyer's marketplace
     *
     * Replaces the resource <select> with tabs and performs every request
     * (switch resource, refresh, buy, sell, list, remove) via fetch().
     *
     * Server protocol (from backend_marketplace.php / backend_buyermarketplace.php):
     *   - $_SESSION["token_<market>"] is a single-use token.  Every POST must
     *     include it as token_<market>; every POST rotates it.  Each HTML
     *     response carries the fresh token in its hidden inputs.
     *   - The deals list is only rendered for POST requests, so "loading" a
     *     market means POSTing {token, mode, resource_id} with no action.
     *   - A "Try again." error means the token mismatched and NOTHING was
     *     executed (all actions are inside `if (!$errors)`), so one automatic
     *     retry with the token from that same response is always safe.
     * ===================================================================== */

    Core.register({
        name: 'marketplace',

        matches(page) {
            return page === 'marketplace.php' || page === 'buyermarketplace.php';
        },

        init(core) {
            const KIND = location.pathname.includes('buyermarketplace') ? 'buyer' : 'sell';
            const PAGE_URL = location.pathname;

            /* ---------------- parsing ---------------- */

            function parseToken(doc) {
                const input = doc.querySelector('input[name^="token_"]');
                return input ? { field: input.getAttribute('name'), value: input.value } : null;
            }

            function parseMode(doc) {
                const input = doc.querySelector('input[name="mode"]');
                return input ? input.value : '';
            }

            function parseFunds(doc) {
                for (const well of doc.querySelectorAll('#content .well')) {
                    if (well.textContent.includes('Funds:')) {
                        const v = well.querySelector('.text-success');
                        if (v) return v.textContent.trim();
                    }
                }
                return null;
            }

            // "(Have N)" suffixes come straight from the server's option list.
            function parseResources(doc) {
                const out = [];
                for (const opt of doc.querySelectorAll('select[name="resource_id"] option')) {
                    if (!opt.value) continue;
                    const label = opt.textContent.trim();
                    const m = label.match(/^(.*?)\s*\(Have (\d+)\)$/);
                    out.push({
                        id: opt.value,
                        name: m ? m[1] : label,
                        have: m ? parseInt(m[2], 10) : 0,
                        selected: opt.hasAttribute('selected'),
                    });
                }
                return out;
            }

            // {buy: 1.05, sell: 0.95} from the "Due to your economic type" alert.
            function parseMultipliers(doc) {
                for (const alert of doc.querySelectorAll('#content .alert-info')) {
                    const t = alert.textContent;
                    if (!t.includes('economic type')) continue;
                    const m = t.match(/pay\s+([\d.]+)%.*?receive\s+([\d.]+)%/s);
                    if (m) return { buy: 1 + parseFloat(m[1]) / 100, sell: 1 - parseFloat(m[2]) / 100 };
                }
                return { buy: 1, sell: 1 };
            }

            function parseMessages(doc) {
                const errors = [], infos = [];
                for (const d of doc.querySelectorAll('#content .alert-danger div.error')) errors.push(d.innerHTML.trim());
                for (const d of doc.querySelectorAll('#content .alert-info div.info')) infos.push(d.innerHTML.trim());
                return { errors, infos };
            }

            function parseDeals(doc) {
                const deals = [];
                const tbody = doc.querySelector('#content table.table tbody');
                if (!tbody) return deals;
                for (const tr of tbody.querySelectorAll('tr')) {
                    const form = tr.querySelector('form');
                    if (!form) continue;
                    const hidden = {};
                    for (const inp of form.querySelectorAll('input[type="hidden"]')) hidden[inp.name] = inp.value;
                    const seller = tr.querySelector('a[href*="viewnation.php"]');
                    const amount = tr.querySelector('p.text-success');
                    deals.push({
                        resourceId: hidden.resource_id,
                        counterpartyId: hidden.buyingfrom_id || hidden.sellingto_id,
                        price: parseInt(hidden.price, 10),
                        amount: amount ? parseInt(amount.textContent.trim(), 10) : 0,
                        own: !!tr.querySelector('input[type="submit"][value="Remove from Marketplace"]'),
                        sellerHtml: seller ? seller.outerHTML : '?',
                    });
                }
                return deals;
            }

            /* ---------------- state ---------------- */

            const initialToken = parseToken(document);
            if (!initialToken) {
                console.warn('[CLOP-US] marketplace: no token on page (not logged in?), leaving page alone');
                return;
            }

            const state = {
                tokenField: initialToken.field,
                token: initialToken.value,
                mode: parseMode(document),                     // '' | 'weapons' | 'armor'
                mult: parseMultipliers(document),
                funds: parseFunds(document),
                resources: parseResources(document),
                deals: parseDeals(document),
                activeId: null,
                messages: { errors: [], infos: [] },
                updatedAt: null,
                busy: false,
                showDna: false,
            };

            const storageKey = `clopus.market.last.${KIND}.${state.mode || 'resources'}`;
            const SHOW_DNA_KEY = 'clopus.market.showDna';
            try { state.showDna = localStorage.getItem(SHOW_DNA_KEY) === '1'; } catch (e) { /* storage disabled */ }
            const selected = state.resources.find((r) => r.selected);
            if (selected) {
                state.activeId = selected.id;
                const emptyMarket = [...document.querySelectorAll('#content .alert-warning')]
                    .some((w) => /not on the market|Nobody wants to buy/.test(w.textContent));
                if (state.deals.length || emptyMarket) state.updatedAt = new Date();
            } else {
                try {
                    const remembered = localStorage.getItem(storageKey);
                    if (remembered && state.resources.some((r) => r.id === remembered)) state.activeId = remembered;
                } catch (e) { /* storage disabled */ }
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

            /* ---------------- networking ---------------- */

            function absorb(doc) {
                const tok = parseToken(doc);
                if (!tok) {
                    throw new Error('Session expired or unexpected response — please reload the page and log in.');
                }
                state.tokenField = tok.field;
                state.token = tok.value;
                return doc;
            }

            const isTryAgain = (html) => /^\s*Try again\.?\s*$/i.test(html.replace(/<[^>]*>/g, ''));

            // POST with the current token; on "Try again." (stale token, e.g.
            // another browser tab consumed it) retry once with the fresh token
            // that arrived in the failed response.
            async function request(params) {
                let doc = absorb(await core.http.postForm(PAGE_URL, {
                    [state.tokenField]: state.token, mode: state.mode, ...params,
                }));
                let messages = parseMessages(doc);
                if (messages.errors.some(isTryAgain)) {
                    doc = absorb(await core.http.postForm(PAGE_URL, {
                        [state.tokenField]: state.token, mode: state.mode, ...params,
                    }));
                    messages = parseMessages(doc);
                    messages.errors = messages.errors.filter((e) => !isTryAgain(e));
                }
                return { doc, messages };
            }

            // Every marketplace POST response contains the full page state for
            // the posted resource_id: fresh deals, funds, "Have" counts.
            async function perform(params, resourceId) {
                if (state.busy) return;
                setBusy(true);
                try {
                    const { doc, messages } = await request({ resource_id: resourceId, ...params });
                    state.activeId = resourceId;
                    state.deals = parseDeals(doc);
                    state.funds = parseFunds(doc) || state.funds;
                    const res = parseResources(doc);
                    if (res.length) state.resources = res;
                    state.messages = messages;
                    state.updatedAt = new Date();
                    try { localStorage.setItem(storageKey, resourceId); } catch (e) { /* ignore */ }
                } catch (e) {
                    state.messages = { errors: [String(e.message || e)], infos: [] };
                } finally {
                    setBusy(false);
                    render();
                }
            }

            const loadMarket = (resourceId) => perform({}, resourceId);

            /* ---------------- UI ---------------- */

            core.addStyle(`
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
                #clop-market-root .clop-dna-toggle { white-space: nowrap; font-weight: normal; cursor: pointer; margin: 12px 0 0 0; }
                #clop-market-root .clop-dna-toggle input { margin-right: 4px; }
                #clop-market-root.clop-busy .clop-action { pointer-events: none; opacity: .55; }
                #clop-market-root .clop-updated { font-size: 85%; }
            `);

            const content = document.getElementById('content');
            const el = core.el.bind(core);

            // Hide the server-rendered widgets we replace (economic-type
            // alert, funds well, the <select> form, deals table / warning).
            function hideOriginalUi() {
                for (const alert of content.querySelectorAll(':scope .alert-info')) {
                    if (alert.textContent.includes('economic type') && !alert.querySelector('div.info')) alert.style.display = 'none';
                }
                for (const well of content.querySelectorAll(':scope .well')) {
                    if (well.textContent.includes('Funds:')) (well.closest('center') || well).style.display = 'none';
                }
                const select = content.querySelector('select[name="resource_id"]');
                if (select) {
                    const form = select.closest('form');
                    (form.closest('center') || form).style.display = 'none';
                }
                const table = content.querySelector('table.table');
                if (table) (table.closest('center') || table).style.display = 'none';
                for (const warn of content.querySelectorAll(':scope .alert-warning')) {
                    if (/not on the market|Nobody wants to buy/.test(warn.textContent)) warn.style.display = 'none';
                }
            }

            const root = el('div', { id: 'clop-market-root' });

            function multiplierNote() {
                const buyPct = Math.round((state.mult.buy - 1) * 1000) / 10;
                const sellPct = Math.round((1 - state.mult.sell) * 1000) / 10;
                return KIND === 'sell'
                    ? `You pay ${buyPct}% over listed prices; you receive ${sellPct}% less when your listings sell.`
                    : `You pay ${buyPct}% extra when offering to buy; you receive ${sellPct}% less when selling to an offer.`;
            }

            function render() {
                root.textContent = '';
                root.classList.toggle('clop-busy', state.busy);

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
                        onclick: () => { if (state.activeId) loadMarket(state.activeId); },
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

                /* resource tabs (DNA hidden unless toggled; the active tab always stays visible) */
                const hasDna = state.resources.some((r) => isDna(r.name));
                const visible = state.resources.filter((r) => state.showDna || !isDna(r.name) || r.id === state.activeId);
                const tabs = el('ul', { class: 'nav nav-pills clop-tabs' });
                for (const r of visible) {
                    const label = r.have ? `${r.name} (${core.commas(r.have)})` : r.name;
                    const a = el('a', { onclick: () => loadMarket(r.id) }, [label]);
                    tabs.appendChild(el('li', { class: r.id === state.activeId ? 'active clop-action' : 'clop-action' }, [a]));
                }
                const tabsBar = el('div', { class: 'clop-tabsbar' }, [tabs]);
                if (hasDna) {
                    const cb = el('input', {
                        type: 'checkbox',
                        onchange: (ev) => {
                            state.showDna = ev.target.checked;
                            try { localStorage.setItem(SHOW_DNA_KEY, state.showDna ? '1' : '0'); } catch (e) { /* ignore */ }
                            render();
                        },
                    });
                    cb.checked = state.showDna;
                    tabsBar.appendChild(el('label', { class: 'text-muted clop-dna-toggle' }, [cb, ' show DNA']));
                }
                root.appendChild(tabsBar);

                if (!state.activeId) {
                    root.appendChild(el('div', { class: 'alert alert-info' }, ['Pick a resource above to view its market.']));
                    return;
                }

                root.appendChild(renderPlaceForm());
                root.appendChild(renderDeals());
            }

            /* list / offer form for the active resource */
            function renderPlaceForm() {
                const qty = el('input', { class: 'form-control', placeholder: 'Qty' });
                const price = el('input', { class: 'form-control', placeholder: 'Bits each' });
                const note = el('span', { class: 'text-muted' });

                const updateNote = () => {
                    const q = parseInt(qty.value, 10), p = parseInt(price.value, 10);
                    if (!(q > 0) || !(p > 0)) { note.textContent = ''; return; }
                    note.textContent = KIND === 'buyer'
                        ? ` — costs ${core.commas(Math.floor(p * q * state.mult.buy))} bits now (refunded if you remove the offer)`
                        : ` — ${core.commas(Math.floor(p * q * state.mult.sell))} bits if it all sells`;
                };
                qty.addEventListener('input', updateNote);
                price.addEventListener('input', updateNote);

                const submitLabel = KIND === 'sell' ? 'Place on Market' : 'Offer to Buy';
                const form = el('form', {
                    class: 'form-inline clop-place clop-action',
                    onsubmit: (ev) => {
                        ev.preventDefault();
                        if (!/^\d+$/.test(qty.value.trim()) || !/^\d+$/.test(price.value.trim())) {
                            state.messages = { errors: ['Digits only- no commas, periods, or other markers.'], infos: [] };
                            render();
                            return;
                        }
                        const params = { amount: qty.value.trim(), price: price.value.trim() };
                        if (KIND === 'sell') params.action = 'Place on Market';
                        else params.offer = 'Offer to Buy';
                        perform(params, state.activeId);
                    },
                }, [
                    KIND === 'sell' ? 'Place ' : 'Offer to buy ',
                    qty,
                    ` ${resourceName(state.activeId)} at `,
                    price,
                    ' ',
                    el('button', { class: `btn ${KIND === 'sell' ? 'btn-success' : 'btn-info'}`, type: 'submit' }, [submitLabel]),
                    note,
                ]);
                return form;
            }

            function renderDeals() {
                if (!state.deals.length) {
                    const msg = state.updatedAt
                        ? (KIND === 'sell' ? 'That item is not on the market.' : 'Nobody wants to buy that item.')
                        : 'Not loaded yet — hit Refresh.';
                    return el('div', { class: 'alert alert-warning' }, [msg]);
                }

                const thead = el('thead', {}, [el('tr', {}, (
                    KIND === 'sell'
                        ? ['Unit Price', 'Units Available', 'Seller', 'Actions']
                        : ['Offering', 'Amount Wanted', 'Buyer', 'Actions']
                ).map((h) => el('th', {}, [h])))]);

                const tbody = el('tbody');
                for (const deal of state.deals) tbody.appendChild(renderDealRow(deal));

                return el('table', { class: 'table table-striped table-bordered table-condensed' }, [thead, tbody]);
            }

            function renderDealRow(deal) {
                const priceCell = el('td', {}, [el('span', { class: 'text-danger' }, [core.commas(deal.price)])]);
                const unit = (mult) => core.commas(Math.floor(deal.price * mult));
                const total = (mult) => core.commas(Math.floor(deal.price * deal.amount * mult));
                let hint;
                if (deal.own) {
                    // Your own listing/offer: what selling out earns you, or
                    // what your standing offer costs you (already escrowed).
                    hint = KIND === 'sell'
                        ? `you get ${unit(state.mult.sell)} ea. / ${total(state.mult.sell)} for all`
                        : `you pay ${unit(state.mult.buy)} ea. / ${total(state.mult.buy)} for all (escrowed)`;
                } else {
                    hint = KIND === 'sell'
                        ? `you pay ${unit(state.mult.buy)} ea.`
                        : `you get ${unit(state.mult.sell)} ea.`;
                }
                priceCell.appendChild(el('div', {}, [el('small', { class: 'text-muted' }, [hint])]));

                const idField = KIND === 'sell' ? 'buyingfrom_id' : 'sellingto_id';
                const base = { [idField]: deal.counterpartyId, price: String(deal.price) };
                const act = (params) => perform({ ...base, ...params }, deal.resourceId);

                const actions = el('div', { class: 'clop-row-actions clop-action' });
                if (deal.own) {
                    actions.appendChild(el('button', {
                        class: 'btn btn-danger btn-sm', type: 'button',
                        onclick: () => act(KIND === 'sell' ? { action: 'Remove from Marketplace' } : { remove: 'Remove from Marketplace' }),
                    }, ['Remove from Marketplace']));
                } else if (KIND === 'sell') {
                    actions.appendChild(el('button', {
                        class: 'btn btn-primary btn-sm', type: 'button',
                        onclick: () => act({ action: 'Buy One' }),
                    }, ['Buy One']));
                    actions.appendChild(el('button', {
                        class: 'btn btn-warning btn-sm', type: 'button',
                        onclick: () => act({ action: 'Buy All' }),
                    }, [`Buy All (${total(state.mult.buy)} bits)`]));
                    actions.appendChild(amountForm('Buy:', 'btn-success',
                        (n) => act({ action: 'Buy:', buyingamount: n }),
                        (n) => `pay ${core.commas(Math.floor(deal.price * n * state.mult.buy))} bits`));
                } else {
                    actions.appendChild(el('button', {
                        class: 'btn btn-primary btn-sm', type: 'button',
                        onclick: () => act({ sellone: 'Sell One' }),
                    }, ['Sell One']));
                    const have = ownedAmount(deal.resourceId);
                    const sellAll = el('button', {
                        class: 'btn btn-warning btn-sm', type: 'button',
                        onclick: () => act({ sellall: 'Sell All' }),
                    }, [`Sell All (${total(state.mult.sell)} bits)`]);
                    if (have < deal.amount) {
                        sellAll.disabled = true;
                        sellAll.title = `You only have ${core.commas(have)}`;
                    }
                    actions.appendChild(sellAll);
                    actions.appendChild(amountForm('Sell:', 'btn-success',
                        (n) => act({ sellamount: 'Sell:', sellingamount: n }),
                        (n) => `get ${core.commas(Math.floor(deal.price * n * state.mult.sell))} bits`));
                }

                return el('tr', {}, [
                    priceCell,
                    el('td', {}, [el('span', { class: 'text-success' }, [core.commas(deal.amount)])]),
                    el('td', { html: deal.sellerHtml }),
                    el('td', {}, [actions]),
                ]);
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

            hideOriginalUi();
            // Insert after the server-rendered header alerts (errors/infos
            // from a classic POST navigation stay visible above our UI).
            content.insertBefore(root, content.querySelector(':scope > center, :scope > form, :scope > table') || null);
            render();

            // Nothing rendered yet for the remembered resource (deals only
            // come with POST responses) — load it dynamically.
            if (state.activeId && !state.updatedAt) loadMarket(state.activeId);
        },
    });

    Core.boot();
    // Expose for debugging and for future modules living in separate files.
    window.CLOPUS = Core;
})();
