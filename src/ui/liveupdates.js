// Live updates: periodically checks for news without a page reload —
//   * header notification badges (messages, alliance messages, deals,
//     incoming attacks, polls) from the Overview GET whose header the server
//     renders with all counts, and
//   * alliance/friend orders in WATCHED favourite markets (either side,
//     any mode; see marketNotifyEnabled), via the market sweep, and
//   * low resource and satisfaction buffers from the Overview page.
//
// CROSS-TAB DESIGN: one elected leader polls; all
// state is shared through localStorage and `storage` events:
//   clopx.live.leader    {id, at}         heartbeat of the leader tab
//   clopx.live.nextAt    number           when the next poll is due
//   clopx.live.pollNow   number           "poll immediately" signal
//   clopx.live.focus     {id, at}         currently focused game tab
//   clopx.live.badges    {at, values, tickSeconds} last header snapshot
//   clopx.live.overview  {at, ...}        last Overview safety values
//   clopx.live.polled    number           a poll cycle finished (signal)
//   clopx.live.success   number           last fully successful poll
//   clopx.live.error     {at, detail}     latest poll failure, cleared on success
//   clopx.live.notification {at, state, detail} last delivery attempt
//   clopx.live.friendly  {key: {...}}     the friendly-order cache, keyed
//                                          "mode|side|resourceId" (mode ''
//                                          is stored as "resources")
// A takeover can overlap an in-flight request: localStorage is not an atomic
// lock. Recheck ownership before fetching and after awaits so a superseded
// tab does not publish stale results or schedule another cycle.
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
import { headerBadges, applyHeaderBadges, fetchedTickSeconds, HEADER_PROBE_PAGE } from '../adapters/header.js';
import { createTickTimer } from './tick-timer.js';
import { isLoggedInDoc, login, CRED_KEY } from '../adapters/session.js';
import { protectedReserve } from '../lib/upkeep-safety.js';
import {
    fetchResourceStats, newlyCriticalOverviewBuffers, overviewResourceRows,
    overviewSatisfactionRow, parseResourceStats, publishResourceStats,
    readCachedResourceStats, RESOURCE_STATS_CACHE_KEY, resourceBufferSummary,
} from '../adapters/overview.js';
import { readFavourites } from '../lib/favourites.js';
import { createLiveTab } from '../lib/live-tab.js';
import { deliverNotification, requestNotificationPermission } from '../lib/desktop-notifications.js';
import { createNotificationPermissionNotice } from './notification-permission.js';

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
    focus: 'clopx.live.focus',
    error: 'clopx.live.error',
    notification: 'clopx.live.notification',
    badges: 'clopx.live.badges',
    polled: 'clopx.live.polled',
    success: 'clopx.live.success',
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

export function marketBadgeAccentForStockColor(stockBackground) {
    const channels = String(stockBackground).match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length < 3) return '#5bc0de';
    const [red, green, blue] = channels;
    return blue - red >= 60 && blue - green >= 25 ? '#5cb85c' : '#5bc0de';
}

export function buyerResourceHasSpare(stats, resourceName, fallback = true) {
    if (!stats || !resourceName) return fallback;
    const resource = stats.byName && stats.byName[String(resourceName).toLowerCase()];
    if (!resource) return fallback;
    return resource.qty > protectedReserve(resource);
}

export function isOverviewDestination(href, baseHref) {
    const raw = String(href || '').trim();
    // Fragment-only and query-only controls stay on the current page. On
    // overview.php they must not be mistaken for links *to* Overview.
    if (!raw || raw.startsWith('#') || raw.startsWith('?') || /^javascript:/i.test(raw)) return false;
    try {
        return new URL(raw, baseHref).pathname.replace(/^.*\//, '') === 'overview.php';
    } catch (e) {
        return false;
    }
}

export function overviewMenuAnchors(doc, baseHref) {
    const destinations = [...doc.querySelectorAll('nav.navbar a[href]')]
        .filter((anchor) => isOverviewDestination(anchor.getAttribute('href'), baseHref));
    const anchors = new Set(destinations);
    for (const destination of destinations) {
        const dropdown = destination.closest('ul.dropdown-menu')?.closest('li.dropdown');
        const heading = dropdown?.querySelector(':scope > a.dropdown-toggle');
        if (heading) anchors.add(heading);
    }
    return [...anchors];
}

export function resourceBufferTitleMarker(summary) {
    if (summary && (summary.criticalCount
        || (summary.critical && summary.critical.length)
        || (summary.satisfaction && summary.satisfaction.severity === 'critical'))) return '!!';
    if (summary && (summary.warningCount
        || (summary.warning && summary.warning.length)
        || (summary.satisfaction && summary.satisfaction.severity === 'warning'))) return '!';
    return '';
}

export function overviewMenuBadgeCounts(summary) {
    return {
        warning: Math.max(0, Number(summary && summary.warningCount) || 0),
        critical: Math.max(0, Number(summary && summary.criticalCount) || 0),
    };
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
            label: 'Live updates (messages, alliance, markets, resources)',
            description: 'Periodically check for new messages, alliance messages, alliance orders in favourite markets, and low resource or satisfaction buffers, updating the header badges in place.',
            type: 'bool',
            default: true,
            reload: true,
        });
        core.settings.define({
            key: 'live.intervalFocused',
            section: 'Live updates',
            label: 'Live update interval while a tab is focused (seconds)',
            description: 'How often to check while a game tab has window focus.',
            type: 'number',
            default: 60,
            onChange: () => core.events.emit('live:intervalChanged', {}),
        });
        core.settings.define({
            key: 'live.intervalBlurred',
            section: 'Live updates',
            label: 'Live update interval in the background (seconds)',
            description: 'Requested interval while no game tab is focused. Browsers may delay background checks, especially on mobile; notifications are best-effort.',
            type: 'number',
            default: 60,
            onChange: () => core.events.emit('live:intervalChanged', {}),
        });
        core.settings.define({
            key: 'live.notify',
            section: 'General',
            label: 'Desktop notifications while no tab is focused',
            description: 'Notify about new messages, alliance messages, deals, incoming attacks, actionable alliance orders in favourite markets, and Overview values newly reaching a critical buffer. On mobile, notifications can be unreliable because the browser or operating system may pause background checks.',
            type: 'bool',
            default: true,
            // The settings-UI click is a user gesture, which is exactly
            // when browsers allow the permission prompt.  Remote tabs adopt
            // the preference but must not try to open their own prompt.
            onChange: (on, { source } = {}) => {
                if (source === 'local' && on
                    && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                    (core.notificationPermission?.request || requestNotificationPermission)()
                        .catch((e) => console.warn('[4clopX] notification permission:', e));
                }
            },
            mount: (host) => core.notificationPermission?.mount(host),
        });
        core.settings.define({
            key: 'live.testNotification', section: 'General', type: 'button',
            label: 'Test notification',
            description: 'Send a test notification. If none appears, check browser/site permissions and system Do Not Disturb.',
            handler: async () => {
                await (core.notificationPermission?.request || requestNotificationPermission)();
                if (!core.liveUpdates?.testNotification()) throw new Error('Could not send the notification; check live-update status.');
            },
        });
        core.settings.define({
            key: 'live.status', section: 'Live updates', type: 'button', feedback: false,
            label: 'Check live-update status',
            description: 'Show the last successful background check and notification delivery attempt.',
            handler: () => core.liveUpdates?.showStatus(),
        });
        core.settings.define({
            key: 'overview.bufferWarningTicks',
            section: 'Overview',
            label: 'Number of ticks until warning',
            description: 'Show a yellow warning when a draining resource has this many usable ticks remaining, or satisfaction has this many safe ticks before the rebel limit.',
            type: 'number',
            default: 5,
            min: 0,
            step: 1,
            onChange: () => core.events.emit('overview:resourceStats', {}),
        });
        core.settings.define({
            key: 'overview.bufferCriticalTicks',
            section: 'Overview',
            label: 'Number of ticks until critical',
            description: 'Show a red critical warning, and allow desktop notification, when a resource or satisfaction reaches this threshold.',
            type: 'number',
            default: 1,
            min: 0,
            step: 1,
            onChange: () => core.events.emit('overview:resourceStats', {}),
        });
        core.settings.define({
            key: 'market.desktopNotifications',
            section: 'Market',
            label: 'Desktop notifications for watched-market orders',
            description: 'Notify about new actionable alliance/friend orders in watched markets. Requires desktop notifications to be enabled in General. Turning this off leaves market polling, badges, and tab-title counts unchanged.',
            type: 'bool',
            default: true,
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
            description: 'Choose a contrasting market accent or the game theme\'s stock notification style for actionable alliance/friend orders. Outlined badges always mean orders you cannot currently fulfil.',
            type: 'choice',
            options: [
                { value: '1', label: 'Accent', example: { text: '3', class: 'clop-choice-example-accent' } },
                { value: '0', label: 'Stock', example: { text: '3', stock: true } },
            ],
            default: '1',
            section: 'Market',
            onChange: (value) => document.body.classList.toggle('clop-accent-market-badges', value === '1'),
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

        core.notificationPermission = createNotificationPermissionNotice(core);

        const el = core.el.bind(core);
        const enabled = core.settings.get('live.enabled');
        const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const ENSURE_EVERY = 10000;
        const tab = createLiveTab({
            id: TAB_ID,
            read: (key) => jget(K[key], null),
            write: (key, value) => jset(K[key], value),
            remove: (key) => { try { localStorage.removeItem(K[key]); } catch (e) { /* unavailable storage */ } },
            focused: () => !document.hidden && document.hasFocus(),
        });

        let leading = false;
        let polling = false;
        let stopped = false;
        let pollTimer = null;
        let currentView = null;      // {mode, side, resourceId, at} open in THIS tab's marketplace
        const loadedAt = (typeof performance !== 'undefined' && performance.timeOrigin) || Date.now();
        const syncTickTimer = createTickTimer(document,
            typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

        const stockBadgeProbe = el('span', { class: 'badge' }, ['0']);
        stockBadgeProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
        document.body.appendChild(stockBadgeProbe);
        const badgeAccent = marketBadgeAccentForStockColor(
            window.getComputedStyle(stockBadgeProbe).backgroundColor,
        );
        stockBadgeProbe.remove();
        document.documentElement.style.setProperty('--clop-market-order-badge-color', badgeAccent);

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
            body.clop-accent-market-badges .clop-actionable-market-badge { background-color: var(--clop-market-order-badge-color, #5bc0de) !important; background-image: none !important; color: #fff !important; text-shadow: none !important; }
            .clop-unavailable-market-badge { background: transparent !important; color: #999 !important; border: 1px solid #aaa; box-shadow: none; text-shadow: none; }
            #clop-market-root .clop-tabs > li.active > a > .clop-unavailable-market-badge { color: rgba(255,255,255,.85) !important; border-color: rgba(255,255,255,.75); }
            .clop-resource-buffer-badge { background-image: none !important; color: #fff !important; box-shadow: none !important; text-shadow: none !important; }
            .clop-resource-buffer-warning { background-color: #f0ad4e !important; }
            .clop-resource-buffer-critical { background-color: #d9534f !important; }
            .clop-resource-row-badge { margin-left: 4px; vertical-align: middle; }
            .clop-satisfaction-row-badge { margin-left: 4px; vertical-align: middle; }
            td.clop-satisfaction-badge-cell { white-space: nowrap; }
            td.clop-resource-badge-cell { width: auto !important; white-space: nowrap; }
            td.clop-resource-badge-cell > img,
            td.clop-resource-badge-cell > .clop-resource-row-badge { display: inline-block; vertical-align: middle; }
        `);
        document.body.classList.toggle('clop-accent-market-badges', core.settings.get('market.blueBadges') === '1');

        /* ---------------- low-resource Overview badges ---------------- */

        const bufferSummary = (stats = readCachedResourceStats()) => resourceBufferSummary(
            stats,
            core.settings.get('overview.bufferWarningTicks'),
            core.settings.get('overview.bufferCriticalTicks'),
        );

        function overviewAnchors() {
            return overviewMenuAnchors(document, location.href);
        }

        function overviewBadgeTitle(summary, severity) {
            const parts = [];
            const resources = severity === 'critical' ? summary.critical : summary.warning;
            const threshold = severity === 'critical'
                ? summary.criticalThreshold
                : summary.warningThreshold;
            if (resources.length) {
                parts.push(`${resources.length} ${severity === 'critical' ? 'critical' : 'low'} resource buffer` +
                    `${resources.length === 1 ? '' : 's'} (≤${threshold} tick` +
                    `${threshold === 1 ? '' : 's'})`);
            }
            if (summary.satisfaction && summary.satisfaction.severity === severity) {
                parts.push(`${severity} satisfaction buffer ` +
                    `(${summary.satisfaction.ticks} safe tick` +
                    `${summary.satisfaction.ticks === 1 ? '' : 's'} to the rebel limit)`);
            }
            return parts.join('; ');
        }

        function updateOverviewBadges() {
            const stats = readCachedResourceStats();
            const summary = bufferSummary(stats);
            const counts = overviewMenuBadgeCounts(summary);
            for (const anchor of overviewAnchors()) {
                const caret = anchor.querySelector(':scope > b.caret');
                for (const severity of ['warning', 'critical']) {
                    let badge = anchor.querySelector(
                        `:scope > .clop-overview-menu-badge.clop-resource-buffer-${severity}`);
                    if (!counts[severity]) {
                        if (badge) badge.remove();
                        continue;
                    }
                    if (!badge) {
                        badge = el('span', {
                            class: 'badge clop-menu-badge clop-overview-menu-badge ' +
                                `clop-resource-buffer-badge clop-resource-buffer-${severity}`,
                        });
                        anchor.insertBefore(badge, caret);
                    }
                    badge.textContent = String(counts[severity]);
                    badge.title = overviewBadgeTitle(summary, severity);
                }
                // Keep the two channels stable and intuitive: warning first,
                // then the more urgent critical count immediately before the caret.
                for (const severity of ['warning', 'critical']) {
                    const badge = anchor.querySelector(
                        `:scope > .clop-overview-menu-badge.clop-resource-buffer-${severity}`);
                    if (badge) anchor.insertBefore(badge, caret);
                }
            }

            const affected = new Map(summary.affected.map((item) => [item.name.toLowerCase(), item]));
            for (const old of document.querySelectorAll('.clop-resource-row-badge')) {
                old.parentElement?.classList.remove('clop-resource-badge-cell');
                old.remove();
            }
            for (const row of overviewResourceRows(document)) {
                const item = affected.get(row.name.toLowerCase());
                if (!item) continue;
                const critical = item.ticks <= summary.criticalThreshold;
                const badge = el('span', {
                    class: 'badge clop-resource-buffer-badge clop-resource-row-badge ' +
                        (critical ? 'clop-resource-buffer-critical' : 'clop-resource-buffer-warning'),
                    title: `${row.name} has ${item.ticks} usable tick${item.ticks === 1 ? '' : 's'} remaining ` +
                        `(${critical ? 'critical' : 'warning'})`,
                }, [critical ? '!!' : '!']);
                const host = row.iconCell || row.nameCell;
                host.classList.add('clop-resource-badge-cell');
                host.appendChild(badge);
            }

            const oldSatisfactionBadge = document.querySelector('.clop-satisfaction-row-badge');
            if (oldSatisfactionBadge) {
                oldSatisfactionBadge.parentElement?.classList.remove('clop-satisfaction-badge-cell');
                oldSatisfactionBadge.remove();
            }
            if (summary.satisfaction) {
                const satisfactionRow = overviewSatisfactionRow(document);
                if (satisfactionRow) {
                    const item = summary.satisfaction;
                    const critical = item.severity === 'critical';
                    satisfactionRow.labelCell.classList.add('clop-satisfaction-badge-cell');
                    satisfactionRow.labelCell.appendChild(el('span', {
                        class: 'badge clop-resource-buffer-badge clop-satisfaction-row-badge ' +
                            (critical ? 'clop-resource-buffer-critical' : 'clop-resource-buffer-warning'),
                        title: `Satisfaction has ${item.ticks} safe tick${item.ticks === 1 ? '' : 's'} ` +
                            `before crossing the ${core.commas(item.rebelThreshold)} rebel limit ` +
                            `(currently ${core.commas(item.value)}, ${item.perTick >= 0 ? '+' : ''}` +
                            `${core.commas(item.perTick)}/tick excluding high-satisfaction decay)`,
                    }, [critical ? '!!' : '!']));
                }
            }
            updateTitle();
        }

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
         * "!! [3] (Mkt: 2) Overview - >CLOP…": Overview-buffer severity;
         * [number of DISTINCT pending
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
            const resources = resourceBufferTitleMarker(bufferSummary());
            document.title = `${resources ? `${resources} ` : ''}` +
                `${notif ? `[${notif}] ` : ''}${market}${baseTitle}`;
        }

        /* ---------------- notifications ---------------- */

        const anyoneLooking = tab.anyoneFocused;

        function sendNotification(body, href, tag) {
            return deliverNotification({
                body, href, tag,
                record: (result) => jset(K.notification, result),
                onClick: (notification, destination) => {
                    try { window.focus(); if (destination) location.assign(destination); notification.close(); }
                    catch (e) { console.warn('[4clopX] notification navigation failed:', e); }
                },
            });
        }

        function notify(body, href, tag) {
            if (!core.settings.get('live.notify')) return;
            if (anyoneLooking()) return;
            sendNotification(body, href, tag);
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
            // A delayed callback can run after another tab has taken over.
            if (polling || stopped || (enabled && !isLeader())) return;
            polling = true;
            try {
                let doc = await core.http.getDoc(HEADER_PROBE_PAGE);
                if (enabled && !isLeader()) return;
                if (!isLoggedInDoc(doc)) {
                    if (!(await tryRelogin())) {
                        stop('session expired — reload the page to log in');
                        return;
                    }
                    doc = await core.http.getDoc(HEADER_PROBE_PAGE);
                    if (enabled && !isLeader()) return;
                }
                const values = headerBadges(doc);
                for (const c of applyHeaderBadges(values)) {
                    const what = NOTIFY_BADGES[c.key];
                    if (what && c.to > c.from) notify(`${c.to} ${what}`, c.key, c.key);
                }
                updateTitle();
                const headerSnapshot = { at: Date.now(), values, tickSeconds: fetchedTickSeconds(doc) };
                syncTickTimer(headerSnapshot);
                jset(K.badges, headerSnapshot);
                // The complete probe can refresh an open Overview in this
                // same tab without another request.  Other tabs receive only
                // the cycle signal below and fetch their own non-persisted
                // copy, keeping form tokens out of shared storage.
                core.events.emit('overview:document', { document: doc });
                let resourceStats = null;
                let overviewError = null;
                try {
                    const previousStats = readCachedResourceStats();
                    resourceStats = parseResourceStats(doc);
                    publishResourceStats(core, resourceStats);
                    const newlyCritical = newlyCriticalOverviewBuffers(
                        previousStats,
                        resourceStats,
                        core.settings.get('overview.bufferWarningTicks'),
                        core.settings.get('overview.bufferCriticalTicks'),
                    );
                    const criticalCount = newlyCritical.resources.length
                        + Number(!!newlyCritical.satisfaction);
                    if (criticalCount) {
                        const details = newlyCritical.resources
                            .map((item) => `${item.name}: ${item.ticks} tick${item.ticks === 1 ? '' : 's'}`);
                        if (newlyCritical.satisfaction) {
                            const item = newlyCritical.satisfaction;
                            details.push(`Satisfaction: ${item.ticks} safe tick` +
                                `${item.ticks === 1 ? '' : 's'} to the rebel limit`);
                        }
                        notify(
                            `Critical Overview buffer${criticalCount === 1 ? '' : 's'} — ${details.join('; ')}`,
                            'overview.php',
                            'overview-buffers');
                    }
                } catch (e) {
                    // Header and market refreshes remain useful if a host
                    // changes the Overview table markup unexpectedly.
                    console.warn('[4clopX] Overview safety refresh failed:', e);
                    overviewError = e;
                }
                await sweepFavourites(resourceStats);
                if (enabled && !isLeader()) return;
                // Cycle done — marketplace tabs (this one directly, others
                // via the K.polled storage event) refresh their open market.
                jset(K.polled, Date.now());
                if (overviewError) jset(K.error, { at: Date.now(), detail: overviewError.message || String(overviewError) });
                else {
                    jset(K.success, Date.now());
                    jset(K.error, null);
                }
                core.events.emit('live:polled', { remote: false });
            } catch (e) {
                console.warn('[4clopX] live update failed:', e);
                if (!enabled || isLeader()) jset(K.error, { at: Date.now(), detail: e.message || String(e) });
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
        async function sweepFavourites(resourceStats = null) {
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

            if (!resourceStats
                && targets.some((t) => t.cacheable && !t.mode && t.side === 'buyer')) {
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
                if (enabled && !isLeader()) return;
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
                if (enabled && !isLeader()) return;
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
                if (core.settings.get('market.desktopNotifications')
                    && p && (summary.count > p.count || summary.amount > p.amount)) {
                    notify(
                        `Alliance/friend ${t.side === 'sell' ? 'sell' : 'buy'} orders in ${next[key].name}: ` +
                        `${summary.count} (${core.commas(summary.amount)})`,
                        marketPageUrl(t.side, t.mode),
                        `market-${key}`);
                }
            }

            if (enabled && !isLeader()) return;
            jset(K.friendly, next);
            core.events.emit('market:friendlyCache', {});
        }

        /* ---------------- leader election ---------------- */

        const isLeader = tab.isLeader;

        function startLeading() {
            if (leading || stopped || !enabled || !isLeader()) return;
            leading = true;
            clearTimeout(pollTimer);
            // Honor the standing schedule — taking over leadership (or
            // loading a page) is not a reason to poll early.
            const storedNext = jget(K.nextAt, 0) || 0;
            if (storedNext) {
                if (storedNext <= Date.now()) poll();
                else pollTimer = setTimeout(poll, storedNext - Date.now());
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
            if (tab.maintain()) startLeading();
            else stopLeading();
        }

        function requestPollNow() {
            if (stopped) return;
            if (!enabled) { poll(); return; }         // one-shot, no scheduling
            ensureLeader();
            if (isLeader()) {
                clearTimeout(pollTimer);
                poll();
            } else {
                jset(K.pollNow, Date.now());          // ask the live leader
            }
        }

        /* ---------------- scheduling & countdown ---------------- */

        function intervalMs() {
            const key = anyoneLooking() ? 'live.intervalFocused' : 'live.intervalBlurred';
            const s = core.settings.get(key);
            return Math.max(10, Number.isFinite(s) && s > 0 ? s : 30) * 1000;
        }

        function schedule() {
            if (!leading || !enabled || stopped || !isLeader()) return;
            clearTimeout(pollTimer);
            const ms = intervalMs();
            jset(K.nextAt, Date.now() + ms);
            pollTimer = setTimeout(poll, ms);
        }

        // Pull the next poll closer when attention warrants it — never push
        // it out.  Runs when this tab's visibility changes AND when any
        // other tab reports gaining focus, so a
        // hidden leader tightens the cadence for a newly-visible follower
        // instead of letting the long countdown run its course.
        function clampSchedule() {
            if (!leading || stopped || polling || !isLeader()) return;
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
            tab.release();
            jset(K.error, { at: Date.now(), detail: reason });
            cdText.textContent = '✖';
            cdText.className = 'text-danger';
            cdLi.querySelector('a').title = `Live updates stopped: ${reason}`;
            console.warn(`[4clopX] live updates stopped: ${reason}`);
        }

        const timestamp = (at) => at ? new Date(at).toLocaleString() : 'None recorded';
        const lastPollStatus = () => `Last successful full check: ${timestamp(jget(K.success, 0))}`;
        core.liveUpdates = {
            testNotification: () => sendNotification('Test notification from 4clopX.', null, 'test'),
            showStatus: () => {
                const error = jget(K.error, null);
                const notification = jget(K.notification, null);
                return core.confirm({
                    title: 'Live-update status', alertOnly: true, dismissLabel: 'OK',
                    body: [
                        `Automatic polling in this tab: ${stopped ? 'stopped' : enabled ? 'enabled' : 'disabled'}.`,
                        lastPollStatus(),
                        `Last Overview/header fetch: ${timestamp(jget(K.badges, null)?.at)}`,
                        `Notification permission: ${typeof Notification === 'undefined' ? 'unavailable' : Notification.permission}`,
                        `Last polling error: ${error ? `${timestamp(error.at)} — ${error.detail}` : 'None recorded'}`,
                        `Last notification attempt: ${notification ? `${timestamp(notification.at)} — ${notification.state}: ${notification.detail}` : 'None recorded'}`,
                        'Status is shared between game tabs. Background checks can be delayed or suspended, especially on mobile. A notification accepted by the browser may still be hidden by system settings.',
                    ].map((text) => el('p', {}, [text])),
                });
            },
        };

        const cdText = el('span', { class: 'text-info' }, ['—']);
        const cdLi = el('li', { class: 'clop-live-countdown' }, [el('a', {
            style: 'cursor: pointer;',
            title: 'Time until the next live update (messages, alliance, favourite markets, resources). Click to update now.',
            onclick: () => requestPollNow(),
        }, ['⟳ ', cdText])]);

        /* ---------------- wiring ---------------- */

        // The rendered Overview is authoritative as of navigation start.
        // Publish it unless a poll completed while this page was loading.
        if (location.pathname.replace(/^.*\//, '') === 'overview.php') {
            const cached = readCachedResourceStats();
            if (!cached || cached.at < loadedAt) {
                try {
                    publishResourceStats(core, parseResourceStats(document), loadedAt);
                } catch (e) {
                    console.warn('[4clopX] could not seed Overview resource badges:', e);
                }
            }
        }

        // Cache-driven UI works on every page, even with live updates off.
        // Cache changes from sweeps, cross-tab storage events, and fresh
        // safety checks all refresh their consumers through shared events.
        updateOverviewBadges();
        updateMenuBadges();
        core.events.on('overview:resourceStats', updateOverviewBadges);
        core.events.on('overview:contentReplaced', updateOverviewBadges);
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
        const storedBadges = jget(K.badges, null);
        if (!storedBadges || storedBadges.at < loadedAt) {
            const snapshot = {
                at: loadedAt, values: headerBadges(document), tickSeconds: fetchedTickSeconds(document),
            };
            jset(K.badges, snapshot);
            syncTickTimer(snapshot);
        } else {
            syncTickTimer(storedBadges);
        }

        window.addEventListener('storage', (ev) => {
            if (stopped || !ev.key) return;
            if (ev.key === K.badges) {
                const rec = jget(K.badges, null);
                if (rec && rec.values) {
                    applyHeaderBadges(rec.values);
                    syncTickTimer(rec);
                    updateTitle();
                }
            } else if (ev.key === K.polled) {
                // Another tab finished a poll cycle.
                core.events.emit('live:polled', { remote: true });
            } else if (ev.key === K.friendly) {
                // Badge data lives in the cache itself; consumers just
                // recompute from it.
                core.events.emit('market:friendlyCache', {});
            } else if (ev.key === RESOURCE_STATS_CACHE_KEY) {
                core.events.emit('overview:resourceStats', {});
            } else if (ev.key === NOTIFY_KEY) {
                // Watch flags changed in another tab: refresh flag-dependent
                // UI.  The toggling tab does any seeding fetch itself; its
                // cache write arrives via the K.friendly event above.
                core.events.emit('market:friendlyCache', {});
            } else if (ev.key === K.focus) {
                clampSchedule();
            } else if (ev.key === K.pollNow) {
                if (isLeader() && enabled) { clearTimeout(pollTimer); poll(); }
            } else if (ev.key === K.leader) {
                if (leading && !isLeader()) stopLeading();
            }
        });

        if (!enabled) return;

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
            cdLi.querySelector('a').title = `${lastPollStatus()}. Click to update now. Background checks are best-effort.`;
            if (polling) { cdText.textContent = '…'; return; }
            const nextAt = jget(K.nextAt, 0) || 0;
            const s = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
            cdText.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }, 1000);

        function reconcile() {
            if (stopped) return;
            tab.stampFocus();
            ensureLeader();
            clampSchedule();
        }
        function suspend() {
            stopLeading();
            tab.release();
        }
        document.addEventListener('visibilitychange', reconcile);
        window.addEventListener('focus', reconcile);
        window.addEventListener('blur', reconcile);
        window.addEventListener('pageshow', reconcile);
        window.addEventListener('online', reconcile);
        document.addEventListener('resume', reconcile);
        document.addEventListener('freeze', suspend);
        window.addEventListener('pagehide', suspend);

        setInterval(reconcile, ENSURE_EVERY);
        reconcile();
    },
};
