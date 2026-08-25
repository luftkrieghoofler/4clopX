// Adapter for the two marketplace endpoints: marketplace.php ("sell orders",
// listings you can buy from) and buyermarketplace.php ("buy orders", offers
// you can sell to).  The weapons/armor variants are the same pages with
// mode=weapons|armor.
//
// Everything that knows the server's HTML shape and form vocabulary lives in
// this file.  The UI layer only sees the adapter interface and
// MarketSnapshot objects:
//
//   snapshot = {
//     kind:       'sell' | 'buyer',
//     resourceId: string | null,     // which resource `orders` belongs to
//     funds:      string | null,     // display string, e.g. "1,234,567"
//     mult:       { buy, sell } | null,  // your economic-type multipliers
//     resources:  [{ id, name, have, selected }],
//     orders:     [{ resourceId, counterpartyId, price, amount, own,
//                    ownerHtml, relation }],
//     messages:   { errors: [html], infos: [html] },
//   }
//
// `relation` is 'friend' | 'enemy' | 'alliance' | null, read from the
// server's own name styling (text-info / text-danger / text-success).  Note
// the server checks in that order, so a friend who is also an alliance mate
// reports 'friend', not 'alliance'.
//
// If the site ever grows a real API, implement the same interface
// (ready / snapshotFromDocument / load / createOrder / takeOrder /
// cancelOrder) against it and the UI won't change.  If the HTML drifts,
// the parse* functions below are the only thing to fix.
//
// Server protocol (from backend_marketplace.php / backend_buyermarketplace.php):
//   - $_SESSION["token_<market>"] is a single-use token, one per market
//     table.  Every POST must include it as token_<market>; every POST
//     rotates it.  Each HTML response carries the fresh token in its hidden
//     inputs.  A GET creates the token if missing but does not rotate it.
//   - The orders list is only rendered for POST requests, so "loading" a
//     market means POSTing {token, mode, resource_id} with no action verb.
//   - A "Try again." error means the token mismatched and NOTHING was
//     executed (all mutations sit inside `if (!$errors)`), so one automatic
//     retry with the token from that same response is always safe.

const PAGES = { sell: 'marketplace.php', buyer: 'buyermarketplace.php' };
export const MARKET_VIEW_HASH_KEY = 'clopx-market';

export function marketPageUrl(kind, mode) {
    return PAGES[kind] + (mode ? `?mode=${encodeURIComponent(mode)}` : '');
}

// The stock server selects markets through POST, so the userscript adds a
// fragment-only deep link.  Fragments never reach the server, remain safe if
// the userscript is disabled, and still behave like real links for middle
// click / open-in-new-tab.
export function marketViewUrl(kind, mode, resourceId) {
    const page = marketPageUrl(kind, mode);
    return resourceId
        ? `${page}#${MARKET_VIEW_HASH_KEY}=${encodeURIComponent(resourceId)}`
        : page;
}

export function marketResourceFromLocation(loc) {
    try {
        const params = new URLSearchParams(String(loc.hash || '').replace(/^#/, ''));
        return params.get(MARKET_VIEW_HASH_KEY) || null;
    } catch (e) {
        return null;
    }
}

export function kindFromLocation(loc) {
    return loc.pathname.includes('buyermarketplace') ? 'buyer' : 'sell';
}

/* ------------------- parsing (drift-sensitive) ------------------- */

export function parseToken(doc) {
    const input = doc.querySelector('input[name^="token_"]');
    return input ? { field: input.getAttribute('name'), value: input.value } : null;
}

export function parseMode(doc) {
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
export function marketResourcesFromDocument(doc) {
    const out = [];
    for (const opt of doc.querySelectorAll('select[name="resource_id"] option')) {
        if (!opt.value) continue;
        const label = opt.textContent.trim();
        const m = label.match(/^(.*?)\s*\(Have ([\d,]+)\)$/);
        out.push({
            id: opt.value,
            name: m ? m[1] : label,
            have: m ? parseInt(m[2].replace(/,/g, ''), 10) : 0,
            selected: opt.hasAttribute('selected'),
        });
    }
    return out;
}

// {buy: 1.05, sell: 0.95} from the "Due to your economic type" alert, or
// null when the alert can't be found (caller keeps its previous value).
function parseMultipliers(doc) {
    for (const alert of doc.querySelectorAll('#content .alert-info')) {
        const t = alert.textContent;
        if (!t.includes('economic type')) continue;
        const m = t.match(/pay\s+([\d.]+)%.*?receive\s+([\d.]+)%/s);
        if (m) return { buy: 1 + parseFloat(m[1]) / 100, sell: 1 - parseFloat(m[2]) / 100 };
    }
    return null;
}

// The static economic-type alert has no div.info children, which is how it
// is told apart from real info messages rendered by header.php.
function parseMessages(doc) {
    const errors = [], infos = [];
    for (const d of doc.querySelectorAll('#content .alert-danger div.error')) errors.push(d.innerHTML.trim());
    for (const d of doc.querySelectorAll('#content .alert-info div.info')) infos.push(d.innerHTML.trim());
    return { errors, infos };
}

// Orders are keyed server-side by (nation_id, resource_id, price); the row
// forms carry exactly those values as hidden inputs.  The viewnation.php
// anchor is kept as-is so the server's friend/enemy/alliance coloring and
// region icons carry over.
function parseOrders(doc) {
    const orders = [];
    const tbody = doc.querySelector('#content table.table tbody');
    if (!tbody) return orders;
    for (const tr of tbody.querySelectorAll('tr')) {
        const form = tr.querySelector('form');
        if (!form) continue;
        const hidden = {};
        for (const inp of form.querySelectorAll('input[type="hidden"]')) hidden[inp.name] = inp.value;
        const owner = tr.querySelector('a[href*="viewnation.php"]');
        const amount = tr.querySelector('p.text-success');
        let relation = null;
        if (owner) {
            if (owner.querySelector('.text-info')) relation = 'friend';
            else if (owner.querySelector('.text-danger')) relation = 'enemy';
            else if (owner.querySelector('.text-success')) relation = 'alliance';
        }
        orders.push({
            resourceId: hidden.resource_id,
            counterpartyId: hidden.buyingfrom_id || hidden.sellingto_id,
            price: parseInt(hidden.price, 10),
            amount: amount ? parseInt(amount.textContent.trim(), 10) : 0,
            own: !!tr.querySelector('input[type="submit"][value="Remove from Marketplace"]'),
            ownerHtml: owner ? owner.outerHTML : '?',
            relation,
        });
    }
    return orders;
}

// The "empty market" warning the stock page shows after a POST with no
// matching orders — used to tell "loaded and empty" from "never loaded".
export function marketIsEmpty(doc) {
    return [...doc.querySelectorAll('#content .alert-warning')]
        .some((w) => /not on the market|Nobody wants to buy/.test(w.textContent));
}

/* --------------- stock-page surgery (drift-sensitive) --------------- */

// Hide the server-rendered widgets the dynamic UI replaces (economic-type
// alert, funds well, the <select> form, orders table / empty warning).
export function hideStockMarketUi(content) {
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

// Where to mount a replacement UI: before the first stock widget, i.e. after
// the header-rendered alerts (errors/infos from a classic POST navigation
// stay visible above it).
export function stockUiInsertionPoint(content) {
    return content.querySelector(':scope > center, :scope > form, :scope > table') || null;
}

// Orders from alliance mates (green) or friends (blue), per the server's
// own styling; own orders excluded.  (Friend styling overrides alliance
// styling server-side, which is why both count.)
export function summarizeFriendly(orders, actionable = true) {
    let amount = 0, count = 0;
    for (const o of orders) {
        if (!o.own && (o.relation === 'alliance' || o.relation === 'friend')) {
            amount += o.amount;
            count += 1;
        }
    }
    return {
        count: actionable ? count : 0,
        amount: actionable ? amount : 0,
        unavailableCount: actionable ? 0 : count,
        unavailableAmount: actionable ? 0 : amount,
        available: actionable,
    };
}

/* ------------------------- the adapter ------------------------- */

const isTryAgain = (html) => /^\s*Try again\.?\s*$/i.test(html.replace(/<[^>]*>/g, ''));

export function createMarketAdapter(core, kind, mode, seedDoc = null) {
    let tokenField = null;
    let token = null;

    function absorbToken(doc) {
        const tok = parseToken(doc);
        if (!tok) throw new Error('Session expired or unexpected response — please reload the page and log in.');
        tokenField = tok.field;
        token = tok.value;
        return doc;
    }

    if (seedDoc) absorbToken(seedDoc);

    function snapshot(doc, messages, resourceId = null) {
        return {
            kind,
            resourceId,
            funds: parseFunds(doc),
            mult: parseMultipliers(doc),
            resources: marketResourcesFromDocument(doc),
            orders: parseOrders(doc),
            messages,
        };
    }

    // Ensure we hold a token for this market.  Needed when the adapter's
    // page is not the one hosting the UI: a GET seeds the session token
    // (creating it server-side if missing) without rotating anything.
    async function ready() {
        if (token) return;
        absorbToken(await core.http.getDoc(marketPageUrl(kind, mode)));
    }

    async function post(params, resourceId) {
        await ready();
        const send = () => core.http.postForm(PAGES[kind], {
            [tokenField]: token, mode, resource_id: resourceId, ...params,
        });
        let doc = absorbToken(await send());
        let messages = parseMessages(doc);
        if (messages.errors.some(isTryAgain)) {
            // Stale token (e.g. another browser tab consumed it); the failed
            // response already delivered the fresh one via absorbToken.
            doc = absorbToken(await send());
            messages = parseMessages(doc);
            messages.errors = messages.errors.filter((e) => !isTryAgain(e));
        }
        return snapshot(doc, messages, resourceId);
    }

    return {
        kind,
        mode,
        ready,

        // Absorb the token from an already-rendered page (the one hosting
        // the UI), saving the GET that ready() would otherwise make.
        seed(doc) {
            absorbToken(doc);
        },

        // Initial state from an already-rendered page — no network.
        snapshotFromDocument(doc) {
            const snap = snapshot(doc, { errors: [], infos: [] });
            const selected = snap.resources.find((r) => r.selected);
            snap.resourceId = selected ? selected.id : null;
            return snap;
        },

        // Every POST response contains the full page state for the posted
        // resource_id: fresh orders, funds, "Have" counts.
        load: (resourceId) => post({}, resourceId),

        createOrder: (resourceId, amount, price) => post(
            kind === 'sell'
                ? { amount, price, action: 'Place on Market' }
                : { amount, price, offer: 'Offer to Buy' },
            resourceId),

        // amount: 'one' | 'all' | a numeric string
        takeOrder(order, amount) {
            const base = kind === 'sell'
                ? { buyingfrom_id: order.counterpartyId, price: String(order.price) }
                : { sellingto_id: order.counterpartyId, price: String(order.price) };
            let verb;
            if (kind === 'sell') {
                verb = amount === 'one' ? { action: 'Buy One' }
                    : amount === 'all' ? { action: 'Buy All' }
                    : { action: 'Buy:', buyingamount: amount };
            } else {
                verb = amount === 'one' ? { sellone: 'Sell One' }
                    : amount === 'all' ? { sellall: 'Sell All' }
                    : { sellamount: 'Sell:', sellingamount: amount };
            }
            return post({ ...base, ...verb }, order.resourceId);
        },

        cancelOrder(order) {
            const base = kind === 'sell'
                ? { buyingfrom_id: order.counterpartyId, action: 'Remove from Marketplace' }
                : { sellingto_id: order.counterpartyId, remove: 'Remove from Marketplace' };
            return post({ ...base, price: String(order.price) }, order.resourceId);
        },
    };
}

// Shared adapter instances, one per (kind, mode).  Every module MUST get
// its adapters through here: the single-use tokens live in the adapter, so
// two instances for the same market in one tab would invalidate each other
// on every POST.
const instances = new Map();
export function marketAdapter(core, kind, mode) {
    const key = `${kind}|${mode}`;
    if (!instances.has(key)) instances.set(key, createMarketAdapter(core, kind, mode));
    return instances.get(key);
}
