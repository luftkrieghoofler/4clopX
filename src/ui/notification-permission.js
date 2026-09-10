import { requestNotificationPermission } from '../lib/desktop-notifications.js';

const PERMISSION_SIGNAL = 'clopx.notificationPermissionChanged';

// One card moves between its settings row and the page corner. Permission is
// always read from the browser; the shared signal is only a refresh hint.
export function createNotificationPermissionNotice(core, {
    doc = document, win = window, notification = () => globalThis.Notification,
    permissions = globalThis.navigator?.permissions,
    signal = () => {
        try { localStorage.setItem(PERMISSION_SIGNAL, `${Date.now()}-${Math.random()}`); }
        catch (e) { /* Focus/permission events still refresh without storage. */ }
    },
} = {}) {
    core.addStyle(`
        .clop-notification-permission { margin: 10px 0 0; border-radius: 6px; padding: 12px; }
        .clop-notification-permission.clop-notification-permission-floating { position: fixed; right: 16px; bottom: 16px; z-index: 9990; width: 355px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow-y: auto; margin: 0; box-shadow: 0 3px 12px rgba(0,0,0,.25); }
        .clop-notification-permission p { margin: 7px 0; }
        .clop-notification-permission-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        .clop-notification-permission [hidden], .clop-notification-permission[hidden] { display: none !important; }
    `);
    const el = core.el.bind(core);
    let settingsOpen = false, inlineHost = null, pending = null;
    let busy = false, error = '', showHelp = false;
    const heading = el('strong');
    const explanation = el('p');
    const feedback = el('p', { role: 'status' });
    const help = el('p', {}, [
        'Open this site’s permissions using the icon beside the browser address, or find this site in the browser’s site-permission settings. Allow Notifications (or reset the blocked permission and try again). On Android, also check that Firefox is allowed to send notifications in Android’s app settings. Return to this tab afterwards; if the browser asks you to reload, do so.',
    ]);
    const grant = el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => {
        if (notification()?.permission === 'denied') {
            showHelp = !showHelp;
            refresh();
        } else {
            request().catch(() => {}); // The card shows the error in place.
        }
    } });
    const disable = el('button', {
        type: 'button', class: 'btn btn-default btn-sm',
        onclick: () => core.settings.set('live.notify', false),
    }, ['Disable notifications']);
    const card = el('div', {
        class: 'alert alert-warning clop-notification-permission',
        role: 'region', 'aria-label': '4clopX notification permissions',
    }, [heading, explanation, feedback, help,
        el('div', { class: 'clop-notification-permission-actions' }, [grant, disable])]);

    function refresh() {
        const api = notification();
        const state = api?.permission || 'unavailable';
        const needed = core.settings.get('live.notify') && state !== 'granted';
        heading.textContent = state === 'unavailable'
            ? '4clopX desktop notifications are unavailable'
            : '4clopX desktop notifications need permission';
        explanation.textContent = state === 'unavailable'
            ? '4clopX notifications are enabled, but this browser does not expose the required notification API.'
            : state === 'denied'
                ? '4clopX notifications are enabled, but browser permission is blocked. Change this site’s browser permissions to allow them.'
                : '4clopX notifications are enabled, but your browser hasn’t allowed them yet.';
        grant.hidden = state === 'unavailable';
        grant.disabled = busy;
        grant.textContent = busy ? 'Waiting for browser…' : state === 'denied' ? 'How to allow' : 'Grant browser permission';
        if (state !== 'denied') showHelp = false;
        help.hidden = !showHelp;
        feedback.textContent = error;
        feedback.hidden = !error || state !== 'default';
        card.hidden = !needed;
        card.classList.toggle('clop-notification-permission-floating', !settingsOpen);
        const target = settingsOpen ? inlineHost : doc.body;
        if (!needed || !target) card.remove();
        else if (card.parentNode !== target) target.appendChild(card);
    }

    function request() {
        if (pending) return pending;
        busy = true;
        error = '';
        refresh();
        // Invoke in the original click/change handler, preserving activation.
        pending = requestNotificationPermission(notification()).catch((e) => {
            error = e.message || String(e);
            throw e;
        }).finally(() => {
            pending = null;
            busy = false;
            refresh();
            signal();
        });
        return pending;
    }

    core.events.on('settings:changed', ({ key }) => {
        if (key === 'live.notify') { error = ''; refresh(); }
    });
    core.events.on('settings:visibility', ({ open }) => { settingsOpen = open; refresh(); });
    win.addEventListener('focus', refresh);
    win.addEventListener('pageshow', refresh);
    doc.addEventListener('visibilitychange', refresh);
    win.addEventListener('storage', (event) => { if (event.key === PERMISSION_SIGNAL) refresh(); });
    // Not all browsers support querying notification permission. Focus and
    // settings events above remain the fallback; querying never prompts.
    try {
        permissions?.query({ name: 'notifications' }).then((status) => {
            status.addEventListener('change', refresh);
            refresh();
        }).catch(() => {});
    } catch (e) { /* Unsupported Permissions API. */ }
    refresh();
    return {
        request,
        mount(host) {
            inlineHost = host;
            refresh();
            return () => { if (inlineHost === host) inlineHost = null; refresh(); };
        },
    };
}
