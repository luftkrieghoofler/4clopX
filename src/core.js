// Core: module registry, serialized HTTP, DOM/storage helpers.
// Nothing in this file knows about any specific CLOP page — that knowledge
// belongs in src/adapters/ (server protocol + HTML scraping) and src/ui/
// (what gets rendered).

const SETTING_STORAGE_PREFIX = 'clopx.setting.';

export const core = {
    version: __CLOPX_VERSION__,
    modules: [],

    // A module is { name, matches(page, location), settings?(core),
    // init(core) } where `page` is the basename of location.pathname.
    // settings() registers the module's core.settings definitions and runs
    // on EVERY page regardless of matches() — the settings panel is global,
    // so definitions must always exist; init() is the page-scoped UI.
    register(mod) {
        this.modules.push(mod);
    },

    boot() {
        const page = location.pathname.replace(/^.*\//, '');
        for (const mod of this.modules) {
            if (!mod.settings) continue;
            try {
                mod.settings(this);
            } catch (e) {
                console.error(`[4clopX] module "${mod.name}" settings registration failed:`, e);
            }
        }
        // Definitions must exist before remote changes can be decoded and
        // dispatched through their onChange hooks.
        this.settings.startSync();
        for (const mod of this.modules) {
            let use = false;
            try { use = mod.matches(page, location); } catch (e) { /* ignore */ }
            if (!use) continue;
            try {
                mod.init(this);
                console.info(`[4clopX] module "${mod.name}" active`);
            } catch (e) {
                console.error(`[4clopX] module "${mod.name}" failed to init:`, e);
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

    /* ---------------- settings ----------------
     * Registry of user-editable settings.  Modules declare theirs with
     * define() at init; a future settings UI will enumerate all() to build
     * itself, so every toggleable behavior must be declared here even while
     * no UI exists.  Values persist under clopx.setting.<key>. */

    settings: {
        _defs: new Map(),
        _syncStarted: false,

        // def: {
        //   key, label, description,
        //   section,               // settings-panel grouping (e.g. 'Market');
        //                          //   sections appear in first-seen order
        //   type: 'bool' | 'number' | 'choice' | 'button',
        //   default,               // bool/number/choice
        //   options,               // choice: [{value, label, example?}]
        //   handler,               // button: invoked by the settings UI
        //   feedback: false,       // button: do not replace its label with
        //                          //   transient progress/completion text
        //   parent,                // optional bool-setting key: indent this
        //                          //   row and disable it while parent is off
        //   onChange,              // optional: called in every open tab as
        //                          //   onChange(value, {source}), where
        //                          //   source is 'local' or 'remote'
        //   reload: true,          // optional: only takes effect after a
        //                          //   page reload (shown in the UI)
        // }
        define(def) {
            this._defs.set(def.key, def);
        },

        all() {
            return [...this._defs.values()];
        },

        get(key) {
            const def = this._defs.get(key);
            const raw = core.storage.get(`${SETTING_STORAGE_PREFIX}${key}`);
            if (raw === null) return def ? def.default : null;
            if (def && def.type === 'bool') return raw === '1';
            if (def && def.type === 'number') {
                const n = Number(raw);
                return Number.isFinite(n) ? n : def.default;
            }
            if (def && def.type === 'choice') {
                return (def.options || []).some((option) => option.value === raw) ? raw : def.default;
            }
            return raw;
        },

        set(key, value) {
            const def = this._defs.get(key);
            const raw = def && def.type === 'bool' ? (value ? '1' : '0') : String(value);
            core.storage.set(`${SETTING_STORAGE_PREFIX}${key}`, raw);
            this._applyChange(key, 'local');
        },

        _applyChange(key, source) {
            const def = this._defs.get(key);
            if (!def) return;
            const value = this.get(key);
            if (def.onChange) {
                try {
                    def.onChange(value, { source });
                } catch (e) {
                    console.error(`[4clopX] setting "${key}" onChange failed:`, e);
                }
            }
            core.events.emit('settings:changed', { key, value, source });
        },

        startSync() {
            if (this._syncStarted || typeof window === 'undefined') return;
            this._syncStarted = true;
            window.addEventListener('storage', (ev) => {
                if (!ev.key || !ev.key.startsWith(SETTING_STORAGE_PREFIX)) return;
                // The browser has already applied the remote value to this
                // tab's localStorage.  Dispatch it without writing again,
                // avoiding storage-event feedback loops.
                this._applyChange(ev.key.slice(SETTING_STORAGE_PREFIX.length), 'remote');
            });
        },
    },

    /* ---------------- events ----------------
     * Minimal pub/sub so modules can share data without importing each
     * other (e.g. the live-update sweep feeding marketplace tab badges). */

    events: {
        _handlers: new Map(),
        on(type, fn) {
            if (!this._handlers.has(type)) this._handlers.set(type, []);
            this._handlers.get(type).push(fn);
        },
        emit(type, data) {
            for (const fn of this._handlers.get(type) || []) {
                try { fn(data); } catch (e) { console.error(`[4clopX] event handler for "${type}" failed:`, e); }
            }
        },
    },

    /* ---------------- secret storage ----------------
     * For credentials and similar.  Exclusively the userscript manager's
     * script-private storage (GM_setValue) — page scripts, site XSS, and
     * other userscripts cannot read it.  There is deliberately NO fallback
     * to page localStorage: features needing secrets must check available()
     * and degrade to "feature off" instead of degrading the storage.  Async
     * API so the Greasemonkey 4 promise flavor also works. */

    secrets: {
        available() {
            return typeof GM_getValue === 'function'
                || (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function');
        },
        _require() {
            if (!this.available()) {
                throw new Error('Secret storage unavailable: the userscript needs the GM_getValue/GM_setValue/GM_deleteValue grants.');
            }
        },
        async get(key) {
            this._require();
            const raw = typeof GM_getValue === 'function' ? GM_getValue(key) : await GM.getValue(key);
            if (raw === null || raw === undefined) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        },
        async set(key, value) {
            this._require();
            const raw = JSON.stringify(value);
            if (typeof GM_setValue === 'function') GM_setValue(key, raw);
            else await GM.setValue(key, raw);
        },
        async remove(key) {
            this._require();
            if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
            else await GM.deleteValue(key);
        },
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
