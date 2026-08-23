// Core: module registry, serialized HTTP, DOM/storage helpers.
// Nothing in this file knows about any specific CLOP page — that knowledge
// belongs in src/adapters/ (server protocol + HTML scraping) and src/ui/
// (what gets rendered).

export const core = {
    version: __CLOPUS_VERSION__,
    modules: [],

    // A module is { name, matches(page, location), init(core) } where `page`
    // is the basename of location.pathname.
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

    /* ---------------- HTTP (serialized) ----------------
     * All requests go through one promise chain: the game's single-use
     * tokens rotate on every POST, so two in-flight requests would
     * invalidate each other. */

    http: {
        _chain: Promise.resolve(),

        _enqueue(run) {
            const p = this._chain.then(run, run);
            this._chain = p.then(() => {}, () => {}); // keep queue alive on errors
            return p;
        },

        _fetchDoc(url, init) {
            return fetch(url, { credentials: 'same-origin', ...init }).then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
                return r.text();
            }).then((text) => new DOMParser().parseFromString(text, 'text/html'));
        },

        // POST form-encoded params, return the response parsed as a Document.
        postForm(url, params) {
            return this._enqueue(() => this._fetchDoc(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params).toString(),
            }));
        },

        // GET a page as a parsed Document.
        getDoc(url) {
            return this._enqueue(() => this._fetchDoc(url, { method: 'GET' }));
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

    /* ---------------- storage ---------------- */

    storage: {
        get(key, fallback = null) {
            try {
                const v = localStorage.getItem(key);
                return v === null ? fallback : v;
            } catch (e) {
                return fallback;
            }
        },
        set(key, value) {
            try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
        },
    },
};
