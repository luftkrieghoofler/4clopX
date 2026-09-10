// Keep detection separate from delivery. A browser accepting a notification
// is not proof that the OS displayed it (e.g. Do Not Disturb).
export async function requestNotificationPermission(NotificationAPI = globalThis.Notification) {
    if (!NotificationAPI) throw new Error('This browser does not expose desktop notifications.');
    const permission = NotificationAPI.permission === 'default'
        ? await NotificationAPI.requestPermission() : NotificationAPI.permission;
    if (permission === 'default') throw new Error('Permission wasn’t granted. You can try again, or disable 4clopX notifications.');
    if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in the site/browser permissions.');
}

export function deliverNotification({ body, href, tag, record, onClick,
    NotificationAPI = globalThis.Notification, now = Date.now, warn = console.warn }) {
    try {
        if (!NotificationAPI) throw new Error('Desktop notifications are unavailable in this browser.');
        if (NotificationAPI.permission !== 'granted') throw new Error('Notification permission is not granted.');
        const notification = new NotificationAPI('CLOP', { body, tag: `clopx-${tag}` });
        const save = (state, detail) => record({ at: now(), state, detail });
        save('requested', 'Sent to the browser; OS display is not guaranteed.');
        notification.onerror = () => {
            const message = 'The browser reported a notification delivery error.';
            save('failed', message);
            warn('[4clopX] ' + message);
        };
        notification.onclick = () => onClick(notification, href);
        return true;
    } catch (error) {
        record({ at: now(), state: 'failed', detail: error.message || String(error) });
        warn('[4clopX] notification failed:', error);
        return false;
    }
}
