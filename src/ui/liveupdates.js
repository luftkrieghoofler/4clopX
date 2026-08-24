// Live updates: periodically checks for news without a page reload —
//   * header notification badges (messages, alliance messages, deals,
//     incoming attacks, polls) via one GET of a cheap page whose header
//     the server renders with all counts, and
//   * alliance/friend orders in favourite markets (both sides, every mode
//     with favourites), via the market sweep.
//
// CROSS-TAB DESIGN: exactly one tab — the elected leader — polls; all
// state is shared through localStorage and `storage` events:
//   clopx.live.leader    {id, at}         heartbeat of the leader tab
//   clopx.live.nextAt    number           when the next poll is due
//   clopx.live.pollNow   number           "poll immediately" signal
//   clopx.live.seen      number           last time any tab was visible
//   clopx.live.badges    {at, values}     last header badge values
//   clopx.live.friendly  {key: {...}}     the friendly-order cache, keyed
//                                          "mode|side|resourceId" (mode ''
//                                          is stored as "resources")
//
// The friendly cache persists across navigations, so page loads neither
// re-run the sweep nor reset notification baselines; the poll timer also
// persists (nextAt), so a page load never resets the schedule.  The one
// exception is deliberate: marketplace pages emit "live:pollNow" on
// load / Refresh / side switch — there the user explicitly wants fresh
// market data, so a full poll runs and the timer restarts.
//
// The cache also powers alliance-order badges on the Capitalism menu (the
// grand total) and on each marketplace submenu entry (that mode+side's
// total), on every page.
//
// Desktop notifications fire only when no tab is visible/focused, from the
// leader.  If the session expires in the background, the poll re-logs-in
// with the stored auto-login credentials (same lockout rules as
// ui/autologin.js) or stops rather than loop.

import { marketAdapter, marketPageUrl, summarizeFriendly } from '../adapters/market.js';
import { headerBadges, applyHeaderBadges, HEADER_PROBE_PAGE } from '../adapters/header.js';
import { isLoggedInDoc, login, CRED_KEY } from '../adapters/session.js';
import { readFavourites } from '../lib/favourites.js';

// Header badges that raise desktop notifications.  Polls are deliberately
// excluded from notifications AND the tab title (never urgent); their
// navbar badge still refreshes like the rest.
const NOTIFY_BADGES = {
    'messages.php': 'unread messages',
    'myalliance.php': 'unread alliance messages',
    'deals.php': 'pending deals',
    'forcesyourway.php': 'incoming attacks',
};

// One key per stock notification category, for the tab-title tally.  Most
// counts appear twice in the navbar (menu toggle + submenu link), so only
// the submenu-link entries are summed to avoid double counting.
const TITLE_BADGES = Object.keys(NOTIFY_BADGES);

const MODES = ['', 'weapons', 'armor'];
const K = {
    leader: 'clopx.live.leader',
    nextAt: 'clopx.live.nextAt',
    pollNow: 'clopx.live.pollNow',
    seen: 'clopx.live.seen',
    badges: 'clopx.live.badges',
    friendly: 'clopx.live.friendly',
};

function jget(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
    } catch (e) {
        return fallback;
    }
}
function jset(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

// The shared friendly-order cache (favourite markets only).
export function readFriendlyCache() {
    return jget(K.friendly, {}) || {};
}

// Patch one market's entry in the shared cache in place — used by the
// marketplace UI, whose every action response carries fresh orders for the
// open market, so badges and titles update without waiting for a sweep.
// Returns true if anything changed.  Callers must only write favourite
// markets (the cache is favourites-only by definition) and emit
// 'market:friendlyCache' when this returns true; the localStorage write
// updates other tabs by itself.
export function writeFriendlyCacheEntry(mode, side, resourceId, summary, name) {
    const cache = readFriendlyCache();
    const key = `${mode || 'resources'}|${side}|${resourceId}`;
    const prev = cache[key];
    if (prev && prev.count === summary.count && prev.amount === summary.amount) return false;
    cache[key] = {
        count: summary.count,
        amount: summary.amount,
        name: name || (prev ? prev.name : `resource ${resourceId}`),
        at: Date.now(),
    };
    jset(K.friendly, cache);
    return true;
}

// Totals across the cached favourite markets of one mode+side.
export function friendlyTotals(mode, side) {
    const prefix = `${mode || 'resources'}|${side}|`;
    let orders = 0, amount = 0;
    for (const [key, v] of Object.entries(readFriendlyCache())) {
        if (key.startsWith(prefix)) { orders += v.count; amount += v.amount; }
    }
    return { orders, amount };
}

// Per-favourite-market watch flags: a watched market is swept on every poll
// and may raise desktop notifications.  Only explicit overrides are stored
// (keyed like the friendly cache); the default is ON for buy orders (offers
// you can sell into — the actionable side) and OFF for sell orders.  A
// future settings UI edits these through core.marketNotify.
const NOTIFY_KEY = 'clopx.market.notify';

export function marketNotifyEnabled(mode, side, resourceId) {
    const overrides = jget(NOTIFY_KEY, {}) || {};
    const v = overrides[`${mode || 'resources'}|${side}|${resourceId}`];
    return typeof v === 'boolean' ? v : side === 'buyer';
}

export function setMarketNotify(mode, side, resourceId, on) {
    const overrides = jget(NOTIFY_KEY, {}) || {};
    overrides[`${mode || 'resources'}|${side}|${resourceId}`] = !!on;
    jset(NOTIFY_KEY, overrides);
}

export const liveUpdatesModule = {
    name: 'liveupdates',

    matches: () => true,

    init(core) {
        core.settings.define({
            key: 'live.enabled',
            label: 'Live updates (messages, alliance, favourite markets)',
            description: 'Periodically check for new messages, alliance messages, and alliance orders in favourite markets, updating the header badges in place.',
            type: 'bool',
            default: true,
        });
        core.settings.define({
            key: 'live.intervalFocused',
            label: 'Live update interval while a tab is visible (seconds)',
            description: 'How often to check while some game tab is being looked at.',
            type: 'number',
            default: 30,
        });
        core.settings.define({
            key: 'live.intervalBlurred',
            label: 'Live update interval in the background (seconds)',
            description: 'How often to check while no game tab is visible.',
            type: 'number',
            default: 120,
        });
        core.settings.define({
            key: 'live.notify',
            label: 'Desktop notifications while no tab is focused',
            description: 'Notify about new messages, alliance messages, deals, incoming attacks, and alliance orders in favourite markets.',
            type: 'bool',
            default: true,
        });
        core.settings.define({
            key: 'live.titleMarket',
            label: 'Market overview in the tab title',
            description: 'Show the watched-market buy-order total as "(Mkt: N)" in the browser tab title. The [N] notifications marker is unaffected.',
            type: 'bool',
            default: true,
        });

        if (!isLoggedInDoc(document)) return;

        const el = core.el.bind(core);
        const enabled = core.settings.get('live.enabled');
        const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const LEADER_TTL = 35000;
        const ENSURE_EVERY = 10000;

        let leading = false;
        let polling = false;
        let stopped = false;
        let pendingPoll = null;      // opts for a poll requested before leading
        let pollTimer = null;

        core.addStyle(`
            .clop-menu-badge { margin-left: 5px; background-color: #5bc0de; color: #fff; }
        `);

        /* ---------------- alliance-order menu badges ---------------- */

        function setMenuBadge(a, count) {
            let b = a.querySelector(':scope > .clop-menu-badge');
            if (!count) {
                if (b) b.remove();
                return;
            }
            if (!b) {
                b = el('span', {
                    class: 'badge clop-menu-badge',
                    title: 'Alliance/friend orders in favourite markets',
                });
                a.insertBefore(b, a.querySelector(':scope > b.caret'));
            }
            b.textContent = String(count);
        }

        // Only buy orders (offers you can sell into) get counted in the blue
        // badges — sell listings are informational, not actionable.
        function updateMenuBadges() {
            let buyTotal = 0;
            for (const [key, v] of Object.entries(readFriendlyCache())) {
                if (key.includes('|buyer|')) buyTotal += v.count;
            }
            for (const a of document.querySelectorAll('nav.navbar a[href^="buyermarketplace.php"]')) {
                const url = new URL(a.getAttribute('href'), location.href);
                setMenuBadge(a, friendlyTotals(url.searchParams.get('mode') || '', 'buyer').orders);
            }
            const cap = [...document.querySelectorAll('nav.navbar a.dropdown-toggle')]
                .find((a) => (a.textContent || '').trim().startsWith('Capitalism'));
            if (cap) setMenuBadge(cap, buyTotal);
            updateTitle();
        }

        /* ---------------- tab title markers ----------------
         * "[3] (Mkt: 2) Overview - >CLOP…": [number of DISTINCT pending
         * notification categories — messages, alliance messages, deals,
         * incoming attacks; not polls] — a count of things to go check,
         * not a sum of items (magnitudes across categories aren't
         * comparable) — shown only when nonzero so a bracket at a glance
         * means news; and the watched-market buy-order total (same number
         * as the blue Capitalism badge), always shown. */

        const baseTitle = document.title;
        function updateTitle() {
            const badges = headerBadges(document);
            let notif = 0;
            for (const key of TITLE_BADGES) {
                if (badges[key] && badges[key].count > 0) notif += 1;
            }
            let market = '';
            if (core.settings.get('live.titleMarket')) {
                let orders = 0;
                for (const [key, v] of Object.entries(readFriendlyCache())) {
                    if (key.includes('|buyer|')) orders += v.count;
                }
                market = `(Mkt: ${orders}) `;
            }
            document.title = `${notif ? `[${notif}] ` : ''}${market}${baseTitle}`;
        }

        /* ---------------- notifications ---------------- */

        const stampSeen = () => { if (!document.hidden) jset(K.seen, Date.now()); };
        const anyoneLooking = () =>
            (!document.hidden && document.hasFocus()) || Date.now() - (jget(K.seen, 0) || 0) < 25000;

        function notify(body, href, tag) {
            if (!core.settings.get('live.notify')) return;
            if (anyoneLooking()) return;
            if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
            try {
                const n = new Notification('CLOP', { body, tag: `clopx-${tag}` });
                n.onclick = () => {
                    try { window.focus(); if (href) location.assign(href); n.close(); } catch (e) { /* ignore */ }
                };
            } catch (e) { /* notification construction can throw on some platforms */ }
        }

        /* ---------------- session recovery ---------------- */

        async function tryRelogin() {
            try {
                if (!core.settings.get('autologin.enabled') || !core.secrets.available()) return false;
                const creds = await core.secrets.get(CRED_KEY);
                if (!creds || !creds.username || creds.disabled) return false;
                const r = await login(core, creds.username, creds.password);
                if (r.ok) {
                    console.info('[4clopX] live updates: session re-established');
                    return true;
                }
                if (/login incorrect/i.test(r.errors[0] || '')) {
                    await core.secrets.set(CRED_KEY, { ...creds, disabled: true });
                }
                return false;
            } catch (e) {
                return false;
            }
        }

        /* ---------------- the poll ---------------- */

        async function poll(opts) {
            const visit = (opts && opts.visit) || null;
            if (polling || stopped) return;
            polling = true;
            try {
                let doc = await core.http.getDoc(HEADER_PROBE_PAGE);
                if (!isLoggedInDoc(doc)) {
                    if (!(await tryRelogin())) {
                        stop('session expired — reload the page to log in');
                        return;
                    }
                    doc = await core.http.getDoc(HEADER_PROBE_PAGE);
                }
                const values = headerBadges(doc);
                for (const c of applyHeaderBadges(values)) {
                    const what = NOTIFY_BADGES[c.key];
                    if (what && c.to > c.from) notify(`${c.to} ${what}`, c.key, c.key);
                }
                updateTitle();
                jset(K.badges, { at: Date.now(), values });
                await sweepFavourites(visit);
            } catch (e) {
                console.warn('[4clopX] live update failed:', e);
            } finally {
                polling = false;
                if (!stopped) schedule();
            }
        }

        // One request per WATCHED favourite market (see marketNotifyEnabled:
        // buy orders by default, sell orders only when opted in), plus the
        // mode+side the user is actively visiting (`visit`), which is swept
        // even when unwatched — silently.  Unswept favourites carry their
        // cached counts over; the previous cache is the notification
        // baseline (first-ever sweep of a market is silent).  The cache is
        // rebuilt wholesale so unfavourited markets drop out, and written
        // only after a fully successful sweep.
        async function sweepFavourites(visit) {
            const prev = readFriendlyCache();
            const next = {};
            for (const mode of MODES) {
                for (const side of ['sell', 'buyer']) {
                    const visiting = !!visit && visit.side === side && (visit.mode || '') === mode;
                    for (const id of readFavourites(side, mode)) {
                        const key = `${mode || 'resources'}|${side}|${id}`;
                        const watched = marketNotifyEnabled(mode, side, id);
                        if (!watched && !visiting) {
                            if (prev[key]) next[key] = prev[key];
                            continue;
                        }
                        const snap = await marketAdapter(core, side, mode).load(id);
                        const summary = summarizeFriendly(snap.orders);
                        const res = snap.resources.find((r) => r.id === id);
                        next[key] = { ...summary, name: res ? res.name : `resource ${id}`, at: Date.now() };
                        core.events.emit('market:friendly', { mode, side, resourceId: id, summary });
                        const p = prev[key];
                        if (watched && p && (summary.count > p.count || summary.amount > p.amount)) {
                            notify(
                                `Alliance/friend ${side === 'sell' ? 'sell' : 'buy'} orders in ${next[key].name}: ` +
                                `${summary.count} (${core.commas(summary.amount)})`,
                                marketPageUrl(side, mode),
                                `market-${key}`);
                        }
                    }
                }
            }
            jset(K.friendly, next);
            core.events.emit('market:friendlyCache', {});
        }

        /* ---------------- leader election ---------------- */

        const leaderRec = () => jget(K.leader, null);
        const isLeader = () => {
            const r = leaderRec();
            return !!r && r.id === TAB_ID;
        };

        function startLeading() {
            if (leading || stopped || !enabled) return;
            leading = true;
            clearTimeout(pollTimer);
            if (pendingPoll) {
                const opts = pendingPoll;
                pendingPoll = null;
                jset(K.nextAt, Date.now());
                poll(opts);
                return;
            }
            // Honor the standing schedule — taking over leadership (or
            // loading a page) is not a reason to poll early.
            const storedNext = jget(K.nextAt, 0) || 0;
            if (storedNext) {
                const delay = Math.max(2000, storedNext - Date.now());
                jset(K.nextAt, Date.now() + delay);
                pollTimer = setTimeout(poll, delay);
            } else {
                schedule();
            }
        }

        function stopLeading() {
            leading = false;
            clearTimeout(pollTimer);
        }

        function ensureLeader() {
            if (stopped || !enabled) return;
            const rec = leaderRec();
            if (rec && rec.id === TAB_ID) {
                jset(K.leader, { id: TAB_ID, at: Date.now() });     // heartbeat
                if (!leading) startLeading();
                return;
            }
            if (!rec || Date.now() - rec.at > LEADER_TTL) {
                jset(K.leader, { id: TAB_ID, at: Date.now() });     // claim
                // Verify after a beat so simultaneous claimants resolve to
                // whoever wrote last.
                setTimeout(() => { if (isLeader()) startLeading(); }, 300 + Math.floor(Math.random() * 400));
            } else if (leading) {
                stopLeading();                                      // superseded
            }
        }

        function requestPollNow(opts) {
            const req = { visit: (opts && opts.visit) || null };
            if (stopped) return;
            if (!enabled) { poll(req); return; }      // one-shot, no scheduling
            if (isLeader()) {
                // Claimed but not yet leading (verify pending): lead now so
                // poll() reschedules properly afterwards.
                if (!leading) { pendingPoll = req; startLeading(); return; }
                clearTimeout(pollTimer);
                poll(req);
                return;
            }
            const rec = leaderRec();
            if (rec && Date.now() - rec.at < LEADER_TTL) {
                jset(K.pollNow, { at: Date.now(), visit: req.visit });   // ask the live leader
            } else {
                pendingPoll = req;                    // claim and poll ourselves
                ensureLeader();
            }
        }

        /* ---------------- scheduling & countdown ---------------- */

        function intervalMs() {
            const key = anyoneLooking() ? 'live.intervalFocused' : 'live.intervalBlurred';
            const s = core.settings.get(key);
            return Math.max(10, Number.isFinite(s) && s > 0 ? s : 30) * 1000;
        }

        function schedule() {
            if (!leading || !enabled || stopped) return;
            clearTimeout(pollTimer);
            const ms = intervalMs();
            jset(K.nextAt, Date.now() + ms);
            pollTimer = setTimeout(poll, ms);
        }

        // Pull the next poll closer when attention warrants it — never push
        // it out.  Runs when this tab's visibility changes AND when any
        // other tab reports becoming visible (its K.seen stamp), so a
        // hidden leader tightens the cadence for a newly-visible follower
        // instead of letting the long countdown run its course.
        function clampSchedule() {
            if (!leading || stopped || polling) return;
            const now = Date.now();
            const nextAt = jget(K.nextAt, 0) || 0;
            if (nextAt && nextAt <= now) {
                // Overdue — the timer was throttled while hidden.
                clearTimeout(pollTimer);
                poll();
                return;
            }
            const target = Math.min(nextAt || Infinity, now + intervalMs());
            if (nextAt && target >= nextAt) return;   // already due sooner
            clearTimeout(pollTimer);
            jset(K.nextAt, target);
            pollTimer = setTimeout(poll, Math.max(0, target - now));
        }

        function stop(reason) {
            stopped = true;
            clearTimeout(pollTimer);
            if (isLeader()) { try { localStorage.removeItem(K.leader); } catch (e) { /* ignore */ } }
            cdText.textContent = '✖';
            cdText.className = 'text-danger';
            cdLi.querySelector('a').title = `Live updates stopped: ${reason}`;
            console.warn(`[4clopX] live updates stopped: ${reason}`);
        }

        const cdText = el('span', { class: 'text-info' }, ['—']);
        const cdLi = el('li', {}, [el('a', {
            style: 'cursor: pointer;',
            title: 'Time until the next live update (messages, alliance, favourite markets). Click to update now.',
            onclick: () => requestPollNow(),
        }, ['⟳ ', cdText])]);

        /* ---------------- wiring ---------------- */

        // Cache-driven UI works on every page, even with live updates off.
        // Every friendly-cache change — sweeps, cross-tab storage events,
        // and in-place patches from marketplace actions — refreshes the
        // menu badges and tab title through this one event.
        updateMenuBadges();
        core.events.on('market:friendlyCache', updateMenuBadges);
        core.events.on('live:pollNow', requestPollNow);

        // Handle for the future settings UI (and the console) to toggle
        // per-market watching: core.marketNotify.enabled/set(mode, side, id).
        core.marketNotify = { enabled: marketNotifyEnabled, set: setMarketNotify };

        // Every page load carries authoritative header counts for free —
        // publish them so other tabs pick up cleared notifications (reading
        // messages, viewing the alliance page) immediately instead of at
        // the next poll.  Skipped when a poll finished after this page
        // started loading, since that data is fresher than our render.
        const loadedAt = (typeof performance !== 'undefined' && performance.timeOrigin) || Date.now();
        const storedBadges = jget(K.badges, null);
        if (!storedBadges || storedBadges.at < loadedAt) {
            jset(K.badges, { at: loadedAt, values: headerBadges(document) });
        }

        window.addEventListener('storage', (ev) => {
            if (stopped || !ev.key) return;
            if (ev.key === K.badges) {
                const rec = jget(K.badges, null);
                if (rec && rec.values) {
                    applyHeaderBadges(rec.values);
                    updateTitle();
                }
            } else if (ev.key === K.friendly) {
                let oldv = {}, newv = {};
                try { oldv = JSON.parse(ev.oldValue || '{}') || {}; } catch (e) { /* ignore */ }
                try { newv = JSON.parse(ev.newValue || '{}') || {}; } catch (e) { /* ignore */ }
                for (const [key, v] of Object.entries(newv)) {
                    const o = oldv[key];
                    if (!o || o.count !== v.count || o.amount !== v.amount) {
                        const [m, side, resourceId] = key.split('|');
                        core.events.emit('market:friendly', {
                            mode: m === 'resources' ? '' : m,
                            side,
                            resourceId,
                            summary: { count: v.count, amount: v.amount },
                        });
                    }
                }
                core.events.emit('market:friendlyCache', {});
            } else if (ev.key === K.seen) {
                clampSchedule();
            } else if (ev.key === K.pollNow) {
                if (isLeader() && enabled) {
                    const rec = jget(K.pollNow, null);
                    clearTimeout(pollTimer);
                    poll({ visit: (rec && rec.visit) || null });
                }
            } else if (ev.key === K.leader) {
                const rec = leaderRec();
                if (leading && rec && rec.id !== TAB_ID && Date.now() - rec.at < LEADER_TTL) stopLeading();
            }
        });

        if (!enabled) return;

        // Browsers only allow the permission prompt on a user gesture.
        if (core.settings.get('live.notify')
            && typeof Notification !== 'undefined' && Notification.permission === 'default') {
            document.addEventListener('click', () => Notification.requestPermission(), { once: true, capture: true });
        }

        const navRight = document.querySelector('nav.navbar ul.navbar-right');
        if (navRight) navRight.insertBefore(cdLi, navRight.firstElementChild);

        setInterval(() => {
            if (stopped) return;
            if (polling) { cdText.textContent = '…'; return; }
            const nextAt = jget(K.nextAt, 0) || 0;
            const s = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
            cdText.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }, 1000);

        stampSeen();
        setInterval(stampSeen, ENSURE_EVERY);
        document.addEventListener('visibilitychange', () => {
            stampSeen();
            clampSchedule();
        });

        window.addEventListener('pagehide', () => {
            if (isLeader()) { try { localStorage.removeItem(K.leader); } catch (e) { /* ignore */ } }
        });

        setInterval(ensureLeader, ENSURE_EVERY);
        ensureLeader();
    },
};
