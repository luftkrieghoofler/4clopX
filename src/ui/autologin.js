// Auto-login: the game's sessions expire frequently, bouncing you to the
// login screen.  This module (opt-in via a checkbox added to the stock
// login form) remembers your credentials and logs you back in
// automatically, then returns you to the link you had just clicked when
// the session bounced you — or, failing that, the last logged-in page you
// were on.
//
// Credentials live ONLY in the userscript manager's script-private storage
// (core.secrets / GM_setValue) — page scripts, site XSS, and other
// userscripts cannot read it.  If the GM grants are missing the feature
// stays off and says so; it never falls back to page-visible storage.
//
// Lockout safety: the server rate-limits FAILED logins (>20/IP/2h), so a
// "Login incorrect." result disables auto-login (flag on the stored
// credentials) until the user logs in manually with the checkbox ticked,
// and attempts are throttled per tab.

import { isLoggedInDoc, findLoginForm, login, CRED_KEY } from '../adapters/session.js';
const LAST_GOOD = 'clopx.nav.lastGood';
const LAST_CLICK = 'clopx.nav.lastClick';
const ATTEMPT_AT = 'clopx.autologin.attemptAt';

// Pages that are pointless to "return" to after a re-login.
const RETURN_BLACKLIST = new Set(['', 'index.php', 'login.php', 'logout.php', 'nonation.php', 'newuser.php']);

function pageOf(url) {
    try { return new URL(url, location.href).pathname.replace(/^.*\//, ''); } catch (e) { return null; }
}

// sessionStorage (per-tab) helpers — survives the redirect chain to the
// login screen but doesn't leak between tabs.
function sget(key) {
    try { const v = sessionStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function sset(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

export const autologinModule = {
    name: 'autologin',

    matches: () => true,

    init(core) {
        core.settings.define({
            key: 'autologin.enabled',
            label: 'Automatically log back in when the session expires',
            description: 'Uses the credentials remembered via the login form checkbox (stored in the userscript manager, unreadable to page scripts).',
            type: 'bool',
            default: true,
        });

        core.autologin = {
            forget: () => core.secrets.remove(CRED_KEY)
                .then(() => console.info('[4clopX] stored credentials removed')),
        };
        core.settings.define({
            key: 'autologin.forget',
            label: 'Forget stored credentials',
            description: 'Erase the username and password saved for auto-login from the userscript manager\'s storage.',
            type: 'button',
            handler: () => core.autologin.forget(),
        });

        // Record every same-origin link click BEFORE navigation: if the next
        // page bounces to the login screen, this is where the user wanted
        // to go.
        document.addEventListener('click', (ev) => {
            const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
            if (!a) return;
            try {
                const url = new URL(a.getAttribute('href'), location.href);
                if (url.origin !== location.origin) return;
                sset(LAST_CLICK, { href: url.href, at: Date.now() });
            } catch (e) { /* ignore */ }
        }, true);

        if (isLoggedInDoc(document)) {
            if (!RETURN_BLACKLIST.has(pageOf(location.href))) {
                sset(LAST_GOOD, { href: location.href, at: Date.now() });
            }
            return;
        }

        const form = findLoginForm(document);
        if (!form) return;

        if (!core.secrets.available()) {
            form.appendChild(core.el('div', { class: 'text-muted' }, [
                'CLOP userscript: auto-login unavailable — the script is running without its GM_getValue/GM_setValue grants.',
            ]));
            return;
        }

        enhanceLoginForm(core, form);
        maybeAutoLogin(core, form);
    },
};

// Add the opt-in checkbox and capture manual logins to save (or forget)
// the credentials.
async function enhanceLoginForm(core, form) {
    const el = core.el.bind(core);
    const stored = await core.secrets.get(CRED_KEY);
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!stored;
    form.appendChild(el('div', { class: 'checkbox' }, [
        el('label', {
            title: 'Log back in automatically whenever the session expires. Credentials are stored in your userscript manager, out of reach of page scripts.',
        }, [cb, ' Auto-login (remember credentials)']),
    ]));
    form.addEventListener('submit', () => {
        const username = (form.querySelector('input[name="username"]') || {}).value;
        const password = (form.querySelector('input[name="password"]') || {}).value;
        if (cb.checked && username && password) {
            core.secrets.set(CRED_KEY, { username: username.trim(), password });
        } else if (!cb.checked) {
            core.secrets.remove(CRED_KEY);
        }
        // The submit itself proceeds normally (server redirects to overview).
    }, true);
}

async function maybeAutoLogin(core, form) {
    if (!core.settings.get('autologin.enabled')) return;
    const creds = await core.secrets.get(CRED_KEY);
    if (!creds || !creds.username || creds.disabled) return;

    // A fresh logout click means the user wants OUT — don't fight them.
    const lastClick = sget(LAST_CLICK);
    if (lastClick && pageOf(lastClick.href) === 'logout.php' && Date.now() - lastClick.at < 60000) {
        console.info('[4clopX] auto-login skipped: you just logged out');
        return;
    }

    // Per-tab throttle so redirect loops can't hammer login.php.
    const lastAttempt = sget(ATTEMPT_AT) || 0;
    if (Date.now() - lastAttempt < 30000) return;
    sset(ATTEMPT_AT, Date.now());

    const el = core.el.bind(core);
    const banner = el('div', { class: 'alert alert-info' }, [`Auto-login: logging back in as ${creds.username}…`]);
    form.parentNode.insertBefore(banner, form);

    const result = await login(core, creds.username, creds.password);
    if (result.ok) {
        banner.textContent = 'Auto-login: success, returning…';
        let target = 'overview.php';
        const good = sget(LAST_GOOD);
        if (lastClick && Date.now() - lastClick.at < 60000 && !RETURN_BLACKLIST.has(pageOf(lastClick.href))) {
            target = lastClick.href;
        } else if (good && !RETURN_BLACKLIST.has(pageOf(good.href))) {
            target = good.href;
        }
        location.replace(target);   // don't leave the login page in history
        return;
    }

    const msg = result.errors[0] || 'unknown error';
    if (/login incorrect/i.test(msg)) {
        // Wrong stored password: never retry (failed logins are rate-limited
        // server-side and could lock the IP out).
        await core.secrets.set(CRED_KEY, { ...creds, disabled: true });
        banner.className = 'alert alert-danger';
        banner.textContent = `Auto-login failed: ${msg} Auto-login is now disabled — log in manually with the checkbox ticked to update the stored credentials.`;
    } else {
        banner.className = 'alert alert-warning';
        banner.textContent = `Auto-login failed: ${msg} — not retrying automatically.`;
    }
}
