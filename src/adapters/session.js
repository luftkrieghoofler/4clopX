// Session/login adapter for the stock header and login.php.
//
// Server facts (backend_login.php, allfunctions.php, header.php):
//   - A dead session is redirected with a plain "Location: index.php" (or
//     nonation.php), so the originally requested URL is lost server-side —
//     returning the user to it is the caller's job (see ui/autologin.js).
//   - header.php renders a login form (name="login_top", POSTs
//     username/password to login.php) on every page when logged out, and
//     the navbar with a logout.php link when logged in.
//   - login.php takes no token.  On success it 302s to overview.php; on
//     failure it re-renders with an error ("Login incorrect.", ban notice,
//     bruteforce notice, ...).
//   - The server rate-limits FAILED logins (>20 per IP per 2 hours), so
//     callers must never loop on a failed login.

export function isLoggedInDoc(doc) {
    return !!doc.querySelector('a[href="logout.php"]');
}

export function findLoginForm(doc) {
    return doc.querySelector('form[name="login_top"]')
        || [...doc.querySelectorAll('form')].find((f) => (f.getAttribute('action') || '').includes('login.php'));
}

export async function login(core, username, password) {
    try {
        const doc = await core.http.postForm('login.php', { username, password });
        if (isLoggedInDoc(doc)) return { ok: true };
        const errors = [...doc.querySelectorAll('.alert-danger .error')].map((d) => d.textContent.trim());
        return { ok: false, errors: errors.length ? errors : ['unexpected response — no error shown'] };
    } catch (e) {
        return { ok: false, errors: [String(e.message || e)] };
    }
}
