// Live updates: periodically checks for news without a page reload —
//   * header notification badges (messages, alliance messages, deals,
//     incoming attacks, polls) via one GET of a cheap page whose header
//     the server renders with all counts, and
//   * alliance/friend orders in WATCHED favourite markets (either side,
//     any mode; see marketNotifyEnabled), via the market sweep.
//
// CROSS-TAB DESIGN: exactly one tab — the elected leader — polls; all
// state is shared through localStorage and `storage` events:
//   clopx.live.leader    {id, at}         heartbeat of the leader tab
//   clopx.live.nextAt    number           when the next poll is due
//   clopx.live.pollNow   number           "poll immediately" signal
//   clopx.live.seen      number           last time any tab was visible
//   clopx.live.badges    {at, values}     last header badge values
//   clopx.live.polled    number           a poll cycle finished (signal)
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
import { fetchResourceStats } from '../adapters/overview.js';
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
export const UNAVAILABLE_SUMMARY_BADGES_KEY = 'market.showUnavailableSummaryBadges';
const K = {
    leader: 'clopx.live.leader',
    nextAt: 'clopx.live.nextAt',
    pollNow: 'clopx.live.pollNow',
    seen: 'clopx.live.seen',
    badges: 'clopx.live.badges',
    polled: 'clopx.live.polled',
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
// Returns true if anything changed.  Callers must only write WATCHED
// markets (the cache is watched-only by definition) and emit
// 'market:friendlyCache' when this returns true; the localStorage write
// updates other tabs by itself.
export function writeFriendlyCacheEntry(mode, side, resourceId, summary, name) {
    const cache = readFriendlyCache();
    const key = `${mode || 'resources'}|${side}|${resourceId}`;
    const prev = cache[key];
    const unavailableCount = summary.unavailableCount || 0;
    const unavailableAmount = summary.unavailableAmount || 0;
    if (prev && prev.count === summary.count && prev.amount === summary.amount
        && (prev.unavailableCount || 0) === unavailableCount
        && (prev.unavailableAmount || 0) === unavailableAmount
        && prev.available === summary.available) return false;
    cache[key] = {
        count: summary.count,
        amount: summary.amount,
        unavailableCount,
        unavailableAmount,
        available: summary.available,
        name: name || (prev ? prev.name : `resource ${resourceId}`),
        at: Date.now(),
    };
    jset(K.friendly, cache);
    return true;
}

// The cache holds exactly the WATCHED markets.  Actionable and unavailable
// totals travel together for badges; notifications and the tab title use
// only the actionable channel.

// Totals for one mode+side.
export function friendlyTotals(mode, side) {
    const prefix = `${mode || 'resources'}|${side}|`;
    let orders = 0, amount = 0, unavailableOrders = 0, unavailableAmount = 0;
    for (const [key, v] of Object.entries(readFriendlyCache())) {
        if (key.startsWith(prefix)) {
            orders += v.count;
            amount += v.amount;
            unavailableOrders += v.unavailableCount || 0;
            unavailableAmount += v.unavailableAmount || 0;
        }
    }
    return { orders, amount, unavailableOrders, unavailableAmount };
}

// Grand totals across all watched markets.
export function watchedOrderTotals() {
    let orders = 0, unavailableOrders = 0;
    for (const v of Object.values(readFriendlyCache())) {
        orders += v.count;
        unavailableOrders += v.unavailableCount || 0;
    }
    return { orders, unavailableOrders };
}

export const watchedOrderTotal = () => watchedOrderTotals().orders;

export function buyerResourceHasSpare(stats, resourceName, fallback = true) {
    if (!stats || !resourceName) return fallback;
    const resource = stats.byName && stats.byName[String(resourceName).toLowerCase()];
    if (!resource) return fallback;
    return resource.qty > resource.used + resource.mil;
}

function targetIsActionable(target, snap, stats, previous) {
    if (target.side !== 'buyer' || target.mode) return true;
    const resource = snap.resources.find((r) => r.id === target.resourceId);
    const fallback = previous && typeof previous.available === 'boolean' ? previous.available : true;
    return buyerResourceHasSpare(stats, resource && resource.name, fallback);
}

// Per-favourite-market watch flags: a watched market is swept on every poll
// and may raise desktop notifications.  Only explicit overrides are stored
// (keyed like the friendly cache); the default is ON for buy orders (offers
// you can sell into — the actionable side) and OFF for sell orders.  A
// future settings UI edits these through core.marketNotify.
const NOTIFY_KEY = 'clopx.market.notify';

export function marketNotifyEnabled(mode, side, resourceId) {
    // Watched ⊆ favourites: an unfavourited market is never watched, no
    // matter what the side default or a stale override says.
    if (!readFavourites(side, mode).some((f) => f.id === resourceId)) return false;
    const overrides = jget(NOTIFY_KEY, {}) || {};
    const v = overrides[`${mode || 'resources'}|${side}|${resourceId}`];
    return typeof v === 'boolean' ? v : side === 'buyer';
}

// Unfavouriting a market forgets its watch override and cached counts, so
// a later re-favourite starts from the side defaults again.
export function forgetMarket(mode, side, resourceId) {
    const key = `${mode || 'resources'}|${side}|${resourceId}`;
    const overrides = jget(NOTIFY_KEY, {}) || {};
    if (key in overrides) {
        delete overrides[key];
        jset(NOTIFY_KEY, overrides);
    }
    const cache = readFriendlyCache();
    if (cache[key]) {
        delete cache[key];
        jset(K.friendly, cache);
    }
}

// Private: all toggling goes through core.marketNotify.set, which layers
// the UI refresh and the seed fetch on top.
function setMarketNotify(mode, side, resourceId, on) {
    const key = `${mode || 'resources'}|${side}|${resourceId}`;
    const overrides = jget(NOTIFY_KEY, {}) || {};
    overrides[key] = !!on;
    jset(NOTIFY_KEY, overrides);
    if (!on) {
        // The cache holds watched markets only — purge immediately so the
        // totals drop without waiting for a sweep.  (A newly watched market
        // is seeded by the next poll or market visit.)
        const cache = readFriendlyCache();
        if (cache[key]) {
            delete cache[key];
            jset(K.friendly, cache);
        }
    }
}

export const liveUpdatesModule = {
    name: 'liveupdates',

    matches: () => true,

    settings(core) {
        core.settings.define({
            key: 'live.enabled',
            section: 'Live updates',
            label: 'Live updates (messages, alliance, favourite markets)',
            description: 'Periodically check for new messages, alliance messages, and alliance orders in favourite markets, updating the header badges in place.',
            type: 'bool',
            default: true,
            reload: true,
        });
        core.settings.define({
            key: 'live.intervalFocused',
            section: 'Live updates',
            label: 'Live update interval while a tab is visible (seconds)',
            description: 'How often to check while some game tab is being looked at.',
            type: 'number',
            default: 30,
            onChange: () => core.events.emit('live:intervalChanged', {}),
        });
        core.settings.define({
            key: 'live.intervalBlurred',
            section: 'Live updates',
            label: 'Live update interval in the background (seconds)',
            description: 'How often to check while no game tab is visible.',
            type: 'number',
            default: 120,
            onChange: () => core.events.emit('live:intervalChanged', {}),
        });
        core.settings.define({
            key: 'live.notify',
            section: 'Live updates',
            label: 'Desktop notifications while no tab is focused',
            description: 'Notify about new messages, alliance messages, deals, incoming attacks, and actionable alliance orders in favourite markets.',
            type: 'bool',
            default: true,
            // The settings-UI click is a user gesture, which is exactly
            // when browsers allow the permission prompt.  Remote tabs adopt
            // the preference but must not try to open their own prompt.
            onChange: (on, { source } = {}) => {
                if (source === 'local' && on
                    && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                    Notification.requestPermission();
                }
            },
        });
        core.settings.define({
            key: 'live.titleMarket',
            section: 'Market',
            label: 'Market overview in the tab title',
            description: 'Show the actionable watched-market order total as "(Mkt: N)" in the browser tab title. Outlined unavailable orders and the [N] notifications marker are unaffected.',
            type: 'bool',
            default: true,
            // Nudge the title to re-render right away.
            onChange: () => core.events.emit('market:friendlyCache', {}),
        });
        core.settings.define({
            key: 'market.blueBadges',
            label: 'Market-order badges',
            description: 'Choose the filled badge colour for actionable alliance/friend orders. Outlined badges always mean orders you cannot currently fulfil.',
            type: 'choice',
            options: [
                { value: '1', label: 'Blue', example: { text: '3', class: 'clop-choice-example-blue' } },
                { value: '0', label: 'Grey', example: { text: '3', class: 'clop-choice-example-grey' } },
            ],
            default: '1',
            section: 'Market',
            onChange: (value) => document.body.classList.toggle('clop-blue-badges', value === '1'),
        });
        core.settings.define({
            key: UNAVAILABLE_SUMMARY_BADGES_KEY,
            label: 'Show outlined unavailable-order summary badges',
            description: 'Show outlined counts in the main menu and Sell Orders/Buy Orders tabs. Individual resource tabs always show them.',
            type: 'bool',
            default: true,
            section: 'Market',
            onChange: () => core.events.emit('market:friendlyCache', {}),
        });
    },

    init(core) {
        if (!isLoggedInDoc(document)) return;

        const el = core.el.bind(core);
        const enabled = core.settings.get('live.enabled');
        const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const LEADER_TTL = 35000;
        const ENSURE_EVERY = 10000;

        let leading = false;
        let polling = false;
        let stopped = false;
        let pendingPoll = false;     // poll requested before this tab led
        let pollTimer = null;
        let currentView = null;      // {mode, side, resourceId, at} open in THIS tab's marketplace

        // True while THIS tab's marketplace loaded exactly this market a
        // few seconds ago — marketplace loads trigger a pollNow, so the
        // sweep must not fetch what the view just fetched.
        const viewIsFresh = (mode, side, resourceId) => {
            const v = currentView;
            return !!v && v.resourceId === resourceId && v.side === side
                && (v.mode || '') === mode && Date.now() - (v.at || 0) < 8000;
        };

        core.addStyle(`
            .clop-menu-badge { margin-left: 5px; }
            .clop-actionable-market-badge { background-color: #777 !important; color: #fff !important; text-shadow: none; }
            body.clop-blue-badges .clop-actionable-market-badge { background-color: #5bc0de !important; color: #fff !important; }
            .clop-unavailable-market-badge { background: transparent !important; color: #999 !important; border: 1px solid #aaa; box-shadow: none; text-shadow: none; }
            #clop-market-root .clop-tabs > li.active > a > .clop-unavailable-market-badge { color: rgba(255,255,255,.85) !important; border-color: rgba(255,255,255,.75); }
        `);
        document.body.classList.toggle('clop-blue-badges', core.settings.get('market.blueBadges') === '1');

        /* ---------------- alliance-order menu badges ---------------- */

        function setMenuBadge(a, count, kind, title) {
            const kindClass = kind === 'actionable'
                ? 'clop-actionable-market-badge'
                : 'clop-unavailable-market-badge';
            let b = a.querySelector(`:scope > .clop-menu-badge.${kindClass}`);
            if (!count) {
                if (b) b.remove();
                return;
            }
            if (!b) {
                b = el('span', {
                    class: `badge clop-menu-badge ${kindClass}`,
                });
                a.insertBefore(b, a.querySelector(':scope > b.caret'));
            }
            b.textContent = String(count);
            b.title = title;
        }

        function setMenuBadges(a, totals) {
            setMenuBadge(a, totals.orders, 'actionable',
                'Actionable alliance/friend orders in watched favourite markets');
            const unavailable = core.settings.get(UNAVAILABLE_SUMMARY_BADGES_KEY)
                ? totals.unavailableOrders
                : 0;
            setMenuBadge(a, unavailable, 'unavailable',
                'Alliance/friend orders you cannot fulfil because you have no stock above upkeep');
            const caret = a.querySelector(':scope > b.caret');
            for (const cls of ['clop-actionable-market-badge', 'clop-unavailable-market-badge']) {
                const badge = a.querySelector(`:scope > .clop-menu-badge.${cls}`);
                if (badge) a.insertBefore(badge, caret);
            }
        }

        // Market badges count watched markets only (defaults: buy-order
        // favourites watched, sell-order favourites not — see the settings
        // panel's watched-markets section).  Filled and outlined counts are
        // deliberately kept as adjacent, separate badges.
        function updateMenuBadges() {
            for (const a of document.querySelectorAll(
                'nav.navbar a[href^="marketplace.php"], nav.navbar a[href^="buyermarketplace.php"]')) {
                const url = new URL(a.getAttribute('href'), location.href);
                const mode = url.searchParams.get('mode') || '';
                const side = url.pathname.includes('buyermarketplace') ? 'buyer' : 'sell';
                setMenuBadges(a, friendlyTotals(mode, side));
            }
            const cap = [...document.querySelectorAll('nav.navbar a.dropdown-toggle')]
                .find((a) => (a.textContent || '').trim().startsWith('Capitalism'));
            if (cap) setMenuBadges(cap, watchedOrderTotals());
            updateTitle();
        }

        /* ---------------- tab title markers ----------------
         * "[3] (Mkt: 2) Overview - >CLOP…": [number of DISTINCT pending
         * notification categories — messages, alliance messages, deals,
         * incoming attacks; not polls] — a count of things to go check,
         * not a sum of items (magnitudes across categories aren't
         * comparable) — shown only when nonzero so a bracket at a glance
         * means news; and the actionable watched-market order total (same
         * number as the filled Capitalism badge), always shown. */

        const baseTitle = document.title;
        function updateTitle() {
            const badges = headerBadges(document);
            let notif = 0;
            for (const key of TITLE_BADGES) {
                if (badges[key] && badges[key].count > 0) notif += 1;
            }
            const market = core.settings.get('live.titleMarket')
                ? `(Mkt: ${watchedOrderTotal()}) `
                : '';
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

        async function poll() {
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
                await sweepFavourites();
                // Cycle done — marketplace tabs (this one directly, others
                // via the K.polled storage event) refresh their open market.
                jset(K.polled, Date.now());
                core.events.emit('live:polled', {});
            } catch (e) {
                console.warn('[4clopX] live update failed:', e);
            } finally {
                polling = false;
                if (!stopped) schedule();
            }
        }

        // One request per target per poll.  Targets are the WATCHED
        // favourites (cacheable: they feed the cache, all badge totals, and
        // notifications) plus — ad hoc — the market open in THIS tab's
        // marketplace when unwatched (view-only: its snapshot is adopted by
        // the view; it never enters the cache and never notifies).  The
        // list is rebuilt every sweep from the favourites and the current
        // market:viewing announcement, so navigating between market tabs,
        // sides, or away from the market is picked up automatically.
        // viewIsFresh() drops any target the view itself loaded moments ago
        // (its load is what triggered this poll).  The previous cache is
        // the notification baseline (first-ever sweep of a market is
        // silent); the cache is rebuilt wholesale so unwatched/unfavourited
        // markets drop out, and written only after every cacheable target
        // succeeded.
        async function sweepFavourites() {
            const prev = readFriendlyCache();
            const next = {};

            const targets = [];
            for (const mode of MODES) {
                for (const side of ['sell', 'buyer']) {
                    for (const fav of readFavourites(side, mode)) {
                        if (!marketNotifyEnabled(mode, side, fav.id)) continue;
                        targets.push({ mode, side, resourceId: fav.id, name: fav.name, cacheable: true });
                    }
                }
            }
            const v = currentView;
            if (v && v.resourceId && !marketNotifyEnabled(v.mode, v.side, v.resourceId)) {
                targets.push({ mode: v.mode, side: v.side, resourceId: v.resourceId, cacheable: false });
            }

            let resourceStats = null;
            if (targets.some((t) => t.cacheable && !t.mode && t.side === 'buyer')) {
                try {
                    // One Overview request classifies every watched resource
                    // buy market for this sweep; never fetch once per market.
                    resourceStats = await fetchResourceStats(core);
                } catch (e) {
                    // Keep each market's previous classification.  New entries
                    // fail open as actionable rather than hiding opportunities.
                    console.warn('[4clopX] resource availability refresh failed:', e);
                }
            }

            for (const t of targets) {
                const key = `${t.mode || 'resources'}|${t.side}|${t.resourceId}`;
                if (viewIsFresh(t.mode, t.side, t.resourceId)) {
                    // Its cache entry (when cacheable) is already fresh and
                    // the baseline advanced — carry it over.
                    if (t.cacheable && prev[key]) next[key] = prev[key];
                    continue;
                }
                let snap;
                try {
                    snap = await marketAdapter(core, t.side, t.mode).load(t.resourceId);
                } catch (e) {
                    if (t.cacheable) throw e;   // abort: don't write a partial cache
                    console.warn('[4clopX] open-market refresh failed:', e);
                    continue;
                }
                const summary = summarizeFriendly(snap.orders,
                    targetIsActionable(t, snap, resourceStats, prev[key]));
                // snap rides along so a marketplace view of this market in
                // THIS tab can adopt the full data instead of re-fetching it
                // (cross-tab only summaries travel, via the cache).
                core.events.emit('market:friendly', {
                    mode: t.mode, side: t.side, resourceId: t.resourceId, summary, snap,
                });
                if (!t.cacheable) continue;
                const res = snap.resources.find((r) => r.id === t.resourceId);
                next[key] = { ...summary, name: res ? res.name : (t.name || `resource ${t.resourceId}`), at: Date.now() };
                const p = prev[key];
                if (p && (summary.count > p.count || summary.amount > p.amount)) {
                    notify(
                        `Alliance/friend ${t.side === 'sell' ? 'sell' : 'buy'} orders in ${next[key].name}: ` +
                        `${summary.count} (${core.commas(summary.amount)})`,
                        marketPageUrl(t.side, t.mode),
                        `market-${key}`);
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
                pendingPoll = false;
                jset(K.nextAt, Date.now());
                poll();
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

        function requestPollNow() {
            if (stopped) return;
            if (!enabled) { poll(); return; }         // one-shot, no scheduling
            if (isLeader()) {
                // Claimed but not yet leading (verify pending): lead now so
                // poll() reschedules properly afterwards.
                if (!leading) { pendingPoll = true; startLeading(); return; }
                clearTimeout(pollTimer);
                poll();
                return;
            }
            const rec = leaderRec();
            if (rec && Date.now() - rec.at < LEADER_TTL) {
                jset(K.pollNow, Date.now());          // ask the live leader
            } else {
                pendingPoll = true;                   // claim and poll ourselves
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
        const cdLi = el('li', { class: 'clop-live-countdown' }, [el('a', {
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
        // Whichever tab is currently the polling leader adopts interval
        // changes immediately, even when they were made in another tab.
        core.events.on('live:intervalChanged', () => {
            if (leading && !polling && !stopped) schedule();
        });
        core.events.on('market:viewing', (v) => { currentView = v; });

        // THE watch-toggle API — the settings panel, the inline market
        // button, and the console all go through here, so every toggle
        // behaves identically no matter which page or tab it happens on:
        //   * the flag is written (and the cache purged on unwatch),
        //   * flag-dependent UI (eye marks, buttons, dashes) refreshes at
        //     once, here and — via the storage events — in other tabs,
        //   * on watch-enable, the market is fetched once (through the
        //     normal serialized queue) to seed the cache, which updates
        //     every badge total everywhere as soon as it lands.
        async function seedWatchedMarket(mode, side, resourceId) {
            try {
                const snap = await marketAdapter(core, side, mode).load(resourceId);
                if (!marketNotifyEnabled(mode, side, resourceId)) return;   // toggled off meanwhile
                const key = `${mode || 'resources'}|${side}|${resourceId}`;
                const previous = readFriendlyCache()[key];
                let resourceStats = null;
                if (!mode && side === 'buyer') {
                    try {
                        resourceStats = await fetchResourceStats(core);
                    } catch (e) {
                        console.warn('[4clopX] resource availability seed failed:', e);
                    }
                }
                const target = { mode, side, resourceId };
                const summary = summarizeFriendly(snap.orders,
                    targetIsActionable(target, snap, resourceStats, previous));
                const res = snap.resources.find((r) => r.id === resourceId);
                if (writeFriendlyCacheEntry(mode, side, resourceId, summary, res && res.name)) {
                    core.events.emit('market:friendlyCache', {});
                }
            } catch (e) {
                console.warn('[4clopX] failed to load newly watched market:', e);
            }
        }
        core.marketNotify = {
            enabled: marketNotifyEnabled,
            set(mode, side, resourceId, on) {
                setMarketNotify(mode, side, resourceId, on);
                core.events.emit('market:friendlyCache', {});
                if (on) seedWatchedMarket(mode, side, resourceId);
            },
        };

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
            } else if (ev.key === K.polled) {
                // Another tab finished a poll cycle.
                core.events.emit('live:polled', {});
            } else if (ev.key === K.friendly) {
                // Badge data lives in the cache itself; consumers just
                // recompute from it.
                core.events.emit('market:friendlyCache', {});
            } else if (ev.key === NOTIFY_KEY) {
                // Watch flags changed in another tab: refresh flag-dependent
                // UI.  The toggling tab does any seeding fetch itself; its
                // cache write arrives via the K.friendly event above.
                core.events.emit('market:friendlyCache', {});
            } else if (ev.key === K.seen) {
                clampSchedule();
            } else if (ev.key === K.pollNow) {
                if (isLeader() && enabled) { clearTimeout(pollTimer); poll(); }
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
        let countdownHome = null;
        if (navRight) {
            // Keep a stable home position immediately after the timer.  A
            // hidden <li> (rather than a comment) also makes controls added
            // later at "firstElementChild" stay ahead of this home slot.
            countdownHome = el('li', {
                class: 'clop-live-countdown-home',
                style: 'display:none;',
                'aria-hidden': 'true',
            });
            navRight.insertBefore(cdLi, navRight.firstChild);
            navRight.insertBefore(countdownHome, cdLi.nextSibling);
        }
        const placeCountdown = () => {
            const shortcutHost = core.settings.get('shortcuts.timerInBar')
                && core.shortcuts && core.shortcuts.toolHost
                ? core.shortcuts.toolHost()
                : null;
            if (shortcutHost) {
                if (cdLi.parentNode !== shortcutHost) shortcutHost.appendChild(cdLi);
            } else if (countdownHome && countdownHome.parentNode) {
                if (cdLi.nextSibling !== countdownHome) {
                    countdownHome.parentNode.insertBefore(cdLi, countdownHome);
                }
            }
        };
        core.events.on('shortcuts:layoutChanged', placeCountdown);
        placeCountdown();

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
