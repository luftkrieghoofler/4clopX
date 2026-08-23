// ==UserScript==
// @name         CLOP Dynamic UI
// @namespace    clop-userscript
// @version      0.3.0
// @description  Modular client-side UI replacement for CLOP. Merged dynamic marketplace (sell/buy orders in one page).
// @match        https://4clop.org/*
// @match        https://*.4clop.org/*
// @match        http://localhost/*
// @match        https://localhost/*
// @updateURL    https://github.com/luftkrieghoofler/4clopX/releases/latest/download/clop.user.js
// @downloadURL  https://github.com/luftkrieghoofler/4clopX/releases/latest/download/clop.user.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
  // src/core.js
  var core = {
    version: "0.3.0",
    modules: [],
    // A module is { name, matches(page, location), init(core) } where `page`
    // is the basename of location.pathname.
    register(mod) {
      this.modules.push(mod);
    },
    boot() {
      const page = location.pathname.replace(/^.*\//, "");
      for (const mod of this.modules) {
        let use = false;
        try {
          use = mod.matches(page, location);
        } catch (e) {
        }
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
        this._chain = p.then(() => {
        }, () => {
        });
        return p;
      },
      _fetchDoc(url, init) {
        return fetch(url, { credentials: "same-origin", ...init }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
          return r.text();
        }).then((text) => new DOMParser().parseFromString(text, "text/html"));
      },
      // POST form-encoded params, return the response parsed as a Document.
      postForm(url, params) {
        return this._enqueue(() => this._fetchDoc(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params).toString()
        }));
      },
      // GET a page as a parsed Document.
      getDoc(url) {
        return this._enqueue(() => this._fetchDoc(url, { method: "GET" }));
      }
    },
    /* ---------------- DOM helpers ---------------- */
    el(tag, attrs, children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
      for (const child of children || []) {
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
      return node;
    },
    addStyle(css) {
      document.head.appendChild(this.el("style", { html: css }));
    },
    commas(n) {
      return Number(n).toLocaleString("en-US");
    },
    /* ---------------- settings ----------------
     * Registry of user-editable settings.  Modules declare theirs with
     * define() at init; a future settings UI will enumerate all() to build
     * itself, so every toggleable behavior must be declared here even while
     * no UI exists.  Values persist under clopus.setting.<key>. */
    settings: {
      _defs: /* @__PURE__ */ new Map(),
      // def: { key, label, description, type: 'bool', default }
      define(def) {
        this._defs.set(def.key, def);
      },
      all() {
        return [...this._defs.values()];
      },
      get(key) {
        const def = this._defs.get(key);
        const raw = core.storage.get(`clopus.setting.${key}`);
        if (raw === null) return def ? def.default : null;
        if (def && def.type === "bool") return raw === "1";
        return raw;
      },
      set(key, value) {
        const def = this._defs.get(key);
        const raw = def && def.type === "bool" ? value ? "1" : "0" : String(value);
        core.storage.set(`clopus.setting.${key}`, raw);
      }
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
        try {
          localStorage.setItem(key, value);
        } catch (e) {
        }
      }
    }
  };

  // src/adapters/market.js
  var PAGES = { sell: "marketplace.php", buyer: "buyermarketplace.php" };
  function marketPageUrl(kind, mode) {
    return PAGES[kind] + (mode ? `?mode=${encodeURIComponent(mode)}` : "");
  }
  function kindFromLocation(loc) {
    return loc.pathname.includes("buyermarketplace") ? "buyer" : "sell";
  }
  function parseToken(doc) {
    const input = doc.querySelector('input[name^="token_"]');
    return input ? { field: input.getAttribute("name"), value: input.value } : null;
  }
  function parseMode(doc) {
    const input = doc.querySelector('input[name="mode"]');
    return input ? input.value : "";
  }
  function parseFunds(doc) {
    for (const well of doc.querySelectorAll("#content .well")) {
      if (well.textContent.includes("Funds:")) {
        const v = well.querySelector(".text-success");
        if (v) return v.textContent.trim();
      }
    }
    return null;
  }
  function parseResources(doc) {
    const out = [];
    for (const opt of doc.querySelectorAll('select[name="resource_id"] option')) {
      if (!opt.value) continue;
      const label = opt.textContent.trim();
      const m = label.match(/^(.*?)\s*\(Have (\d+)\)$/);
      out.push({
        id: opt.value,
        name: m ? m[1] : label,
        have: m ? parseInt(m[2], 10) : 0,
        selected: opt.hasAttribute("selected")
      });
    }
    return out;
  }
  function parseMultipliers(doc) {
    for (const alert of doc.querySelectorAll("#content .alert-info")) {
      const t = alert.textContent;
      if (!t.includes("economic type")) continue;
      const m = t.match(/pay\s+([\d.]+)%.*?receive\s+([\d.]+)%/s);
      if (m) return { buy: 1 + parseFloat(m[1]) / 100, sell: 1 - parseFloat(m[2]) / 100 };
    }
    return null;
  }
  function parseMessages(doc) {
    const errors = [], infos = [];
    for (const d of doc.querySelectorAll("#content .alert-danger div.error")) errors.push(d.innerHTML.trim());
    for (const d of doc.querySelectorAll("#content .alert-info div.info")) infos.push(d.innerHTML.trim());
    return { errors, infos };
  }
  function parseOrders(doc) {
    const orders = [];
    const tbody = doc.querySelector("#content table.table tbody");
    if (!tbody) return orders;
    for (const tr of tbody.querySelectorAll("tr")) {
      const form = tr.querySelector("form");
      if (!form) continue;
      const hidden = {};
      for (const inp of form.querySelectorAll('input[type="hidden"]')) hidden[inp.name] = inp.value;
      const owner = tr.querySelector('a[href*="viewnation.php"]');
      const amount = tr.querySelector("p.text-success");
      let relation = null;
      if (owner) {
        if (owner.querySelector(".text-info")) relation = "friend";
        else if (owner.querySelector(".text-danger")) relation = "enemy";
        else if (owner.querySelector(".text-success")) relation = "alliance";
      }
      orders.push({
        resourceId: hidden.resource_id,
        counterpartyId: hidden.buyingfrom_id || hidden.sellingto_id,
        price: parseInt(hidden.price, 10),
        amount: amount ? parseInt(amount.textContent.trim(), 10) : 0,
        own: !!tr.querySelector('input[type="submit"][value="Remove from Marketplace"]'),
        ownerHtml: owner ? owner.outerHTML : "?",
        relation
      });
    }
    return orders;
  }
  function marketIsEmpty(doc) {
    return [...doc.querySelectorAll("#content .alert-warning")].some((w) => /not on the market|Nobody wants to buy/.test(w.textContent));
  }
  function hideStockMarketUi(content) {
    for (const alert of content.querySelectorAll(":scope .alert-info")) {
      if (alert.textContent.includes("economic type") && !alert.querySelector("div.info")) alert.style.display = "none";
    }
    for (const well of content.querySelectorAll(":scope .well")) {
      if (well.textContent.includes("Funds:")) (well.closest("center") || well).style.display = "none";
    }
    const select = content.querySelector('select[name="resource_id"]');
    if (select) {
      const form = select.closest("form");
      (form.closest("center") || form).style.display = "none";
    }
    const table = content.querySelector("table.table");
    if (table) (table.closest("center") || table).style.display = "none";
    for (const warn of content.querySelectorAll(":scope .alert-warning")) {
      if (/not on the market|Nobody wants to buy/.test(warn.textContent)) warn.style.display = "none";
    }
  }
  function stockUiInsertionPoint(content) {
    return content.querySelector(":scope > center, :scope > form, :scope > table") || null;
  }
  var isTryAgain = (html) => /^\s*Try again\.?\s*$/i.test(html.replace(/<[^>]*>/g, ""));
  function createMarketAdapter(core2, kind, mode, seedDoc = null) {
    let tokenField = null;
    let token = null;
    function absorbToken(doc) {
      const tok = parseToken(doc);
      if (!tok) throw new Error("Session expired or unexpected response — please reload the page and log in.");
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
        resources: parseResources(doc),
        orders: parseOrders(doc),
        messages
      };
    }
    async function ready() {
      if (token) return;
      absorbToken(await core2.http.getDoc(marketPageUrl(kind, mode)));
    }
    async function post(params, resourceId) {
      await ready();
      const send = () => core2.http.postForm(PAGES[kind], {
        [tokenField]: token,
        mode,
        resource_id: resourceId,
        ...params
      });
      let doc = absorbToken(await send());
      let messages = parseMessages(doc);
      if (messages.errors.some(isTryAgain)) {
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
        kind === "sell" ? { amount, price, action: "Place on Market" } : { amount, price, offer: "Offer to Buy" },
        resourceId
      ),
      // amount: 'one' | 'all' | a numeric string
      takeOrder(order, amount) {
        const base = kind === "sell" ? { buyingfrom_id: order.counterpartyId, price: String(order.price) } : { sellingto_id: order.counterpartyId, price: String(order.price) };
        let verb;
        if (kind === "sell") {
          verb = amount === "one" ? { action: "Buy One" } : amount === "all" ? { action: "Buy All" } : { action: "Buy:", buyingamount: amount };
        } else {
          verb = amount === "one" ? { sellone: "Sell One" } : amount === "all" ? { sellall: "Sell All" } : { sellamount: "Sell:", sellingamount: amount };
        }
        return post({ ...base, ...verb }, order.resourceId);
      },
      cancelOrder(order) {
        const base = kind === "sell" ? { buyingfrom_id: order.counterpartyId, action: "Remove from Marketplace" } : { sellingto_id: order.counterpartyId, remove: "Remove from Marketplace" };
        return post({ ...base, price: String(order.price) }, order.resourceId);
      }
    };
  }

  // src/adapters/overview.js
  function cellNumber(text) {
    const n = parseInt(text.replace(/,/g, "").trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }
  function parseResourceStats(doc) {
    for (const panel of doc.querySelectorAll(".panel")) {
      const heading = panel.querySelector(".panel-heading");
      if (!heading || heading.textContent.trim() !== "Resources") continue;
      const table = panel.querySelector("table");
      if (!table) break;
      const headCells = [...table.querySelectorAll("thead td, thead th")].map((c) => c.textContent.trim());
      const cName = headCells.indexOf("Resource");
      const cQty = headCells.indexOf("Qty");
      const cUsed = headCells.indexOf("Used");
      const cNet = headCells.indexOf("Net");
      if (cName < 0 || cQty < 0 || cUsed < 0 || cNet < 0) break;
      const byName = {};
      for (const tr of table.querySelectorAll("tbody tr")) {
        const cells = tr.querySelectorAll("td");
        if (cells.length <= Math.max(cName, cQty, cUsed, cNet)) continue;
        const name = cells[cName].textContent.trim();
        if (!name) continue;
        byName[name.toLowerCase()] = {
          name,
          qty: cellNumber(cells[cQty].textContent),
          used: cellNumber(cells[cUsed].textContent),
          mil: 0,
          net: cellNumber(cells[cNet].textContent)
        };
      }
      for (const c of panel.querySelectorAll("center")) {
        if (!/military also uses/i.test(c.textContent)) continue;
        for (const m of c.textContent.matchAll(/([\d,]+)\s+([A-Za-z]+)/g)) {
          const entry = byName[m[2].toLowerCase()];
          if (entry) entry.mil = cellNumber(m[1]);
        }
      }
      return { byName, at: /* @__PURE__ */ new Date() };
    }
    throw new Error("Could not find the Resources table on the Overview page.");
  }
  async function fetchResourceStats(core2) {
    return parseResourceStats(await core2.http.getDoc("overview.php"));
  }

  // src/ui/marketplace.js
  var SIDES = [
    { side: "sell", label: "Sell Orders", hint: "Listings from sellers — buy from them here." },
    { side: "buyer", label: "Buy Orders", hint: "Standing offers from buyers — sell to them here." }
  ];
  var marketplaceModule = {
    name: "marketplace",
    matches(page) {
      return page === "marketplace.php" || page === "buyermarketplace.php";
    },
    init(core2) {
      if (!parseToken(document)) {
        console.warn("[CLOP-US] marketplace: no token on page (not logged in?), leaving page alone");
        return;
      }
      const el = core2.el.bind(core2);
      const mode = parseMode(document);
      const hostKind = kindFromLocation(location);
      core2.settings.define({
        key: "market.sellMaxNegativeNetConfirm",
        label: 'Confirm "Sell Max" when net production is negative',
        description: "Ask for confirmation before Sell Max empties a stockpile whose per-tick net production is negative (i.e. one you are draining every tick).",
        type: "bool",
        default: true
      });
      const adapters = {
        sell: createMarketAdapter(core2, "sell", mode, hostKind === "sell" ? document : null),
        buyer: createMarketAdapter(core2, "buyer", mode, hostKind === "buyer" ? document : null)
      };
      const lastKey = (side) => `clopus.market.last.${side}.${mode || "resources"}`;
      const SHOW_DNA_KEY = "clopus.market.showDna";
      const FAVS_KEY = `clopus.market.favs.${mode || "resources"}`;
      const FAVS_ONLY_KEY = "clopus.market.favsOnly";
      const state = {
        side: hostKind,
        // 'sell' | 'buyer'
        activeId: null,
        funds: null,
        mult: { buy: 1, sell: 1 },
        resources: [],
        orders: [],
        messages: { errors: [], infos: [] },
        updatedAt: null,
        busy: false,
        showDna: core2.storage.get(SHOW_DNA_KEY, "0") === "1",
        favsOnly: core2.storage.get(FAVS_ONLY_KEY, "0") === "1",
        favs: /* @__PURE__ */ new Set(),
        friendly: { sell: {}, buyer: {} },
        // resourceId -> {amount, count}
        upkeep: null,
        // resource stats from overview.php
        showHelp: false
      };
      try {
        state.favs = new Set(JSON.parse(core2.storage.get(FAVS_KEY, "[]")));
      } catch (e) {
      }
      const saveFavs = () => core2.storage.set(FAVS_KEY, JSON.stringify([...state.favs]));
      const boot = adapters[hostKind].snapshotFromDocument(document);
      state.funds = boot.funds;
      if (boot.mult) state.mult = boot.mult;
      state.resources = boot.resources;
      state.orders = boot.orders;
      if (boot.resourceId) {
        state.activeId = boot.resourceId;
        state.friendly[hostKind][boot.resourceId] = summarizeFriendly(boot.orders);
        if (boot.orders.length || marketIsEmpty(document)) state.updatedAt = /* @__PURE__ */ new Date();
      } else {
        const remembered = core2.storage.get(lastKey(hostKind));
        if (remembered && state.resources.some((r) => r.id === remembered)) state.activeId = remembered;
      }
      function resourceName(id) {
        const r = state.resources.find((x) => x.id === id);
        return r ? r.name : "item";
      }
      function ownedAmount(id) {
        const r = state.resources.find((x) => x.id === id);
        return r ? r.have : 0;
      }
      const isDna = (name) => /^DNA/i.test(name);
      function summarizeFriendly(orders) {
        let amount = 0, count = 0;
        for (const o of orders) {
          if (!o.own && (o.relation === "alliance" || o.relation === "friend")) {
            amount += o.amount;
            count += 1;
          }
        }
        return { amount, count };
      }
      const adapter = () => adapters[state.side];
      function merge(snap) {
        state.orders = snap.orders;
        if (snap.funds) state.funds = snap.funds;
        if (snap.mult) state.mult = snap.mult;
        if (snap.resources.length) state.resources = snap.resources;
        state.messages = snap.messages;
        if (snap.resourceId) {
          state.activeId = snap.resourceId;
          state.friendly[snap.kind][snap.resourceId] = summarizeFriendly(snap.orders);
          core2.storage.set(lastKey(snap.kind), snap.resourceId);
        }
        state.updatedAt = /* @__PURE__ */ new Date();
      }
      async function run(action) {
        if (state.busy) return;
        setBusy(true);
        try {
          merge(await action());
        } catch (e) {
          state.messages = { errors: [String(e.message || e)], infos: [] };
        } finally {
          setBusy(false);
          render();
        }
      }
      const load = (resourceId) => run(() => adapter().load(resourceId));
      let sweepSeq = 0;
      async function sweepFavourites() {
        const seq = ++sweepSeq;
        const side = state.side;
        const targets = [...state.favs].filter((id) => id !== state.activeId && state.resources.some((r) => r.id === id));
        for (const id of targets) {
          if (seq !== sweepSeq || state.side !== side) return;
          try {
            const snap = await adapters[side].load(id);
            state.friendly[side][id] = summarizeFriendly(snap.orders);
            if (snap.resources.length) state.resources = snap.resources;
            updateBadges();
          } catch (e) {
            console.warn("[CLOP-US] favourites sweep stopped:", e);
            return;
          }
        }
      }
      const loadAndSweep = (resourceId) => {
        if (resourceId) load(resourceId).then(sweepFavourites);
        else sweepFavourites();
      };
      const upkeepFor = (resourceId) => state.upkeep ? state.upkeep.byName[resourceName(resourceId).toLowerCase()] || null : null;
      const reserveOf = (up) => up.used + up.mil;
      const reserveText = (up) => up.mil ? `${core2.commas(up.used)}/tick upkeep + ${core2.commas(up.mil)} military/12h` : `${core2.commas(up.used)}/tick upkeep`;
      let upkeepFetching = false;
      async function maybeFetchUpkeep() {
        if (mode || state.upkeep || upkeepFetching) return;
        upkeepFetching = true;
        try {
          state.upkeep = await fetchResourceStats(core2);
          updateSellMaxUi();
        } catch (e) {
          console.warn("[CLOP-US] upkeep fetch failed:", e);
        } finally {
          upkeepFetching = false;
        }
      }
      async function sellMax(order, expected, btn) {
        if (state.busy) return;
        setBusy(true);
        btn.textContent = "⟳ Verifying upkeep…";
        const name = resourceName(order.resourceId);
        try {
          const stats = await fetchResourceStats(core2);
          state.upkeep = stats;
          const fresh = stats.byName[name.toLowerCase()];
          const freshReserve = fresh ? reserveOf(fresh) : null;
          if (!fresh || freshReserve !== expected.reserve) {
            state.messages = {
              errors: [`Not sold: the upkeep of ${name} changed — used to be ${core2.commas(expected.reserve)}, now it's ${fresh ? `${core2.commas(freshReserve)} (${reserveText(fresh)})` : "unknown"}. Check the numbers and try again if you're happy.`],
              infos: []
            };
            return;
          }
          const freshMax = Math.min(fresh.qty - freshReserve, order.amount);
          if (freshMax !== expected.n) {
            state.messages = {
              errors: [`Not sold: your ${name} stock changed — Sell Max would now sell ${core2.commas(Math.max(0, freshMax))} instead of ${core2.commas(expected.n)}. Check the numbers and try again if you're happy.`],
              infos: []
            };
            return;
          }
          if (fresh.net < 0 && core2.settings.get("market.sellMaxNegativeNetConfirm")) {
            const ok = window.confirm(
              `Your net ${name} production is NEGATIVE (${core2.commas(fresh.net)}/tick) — you are draining this stockpile every tick.

Sell ${core2.commas(expected.n)} anyway?`
            );
            if (!ok) return;
          }
          merge(await adapter().takeOrder(order, String(expected.n)));
        } catch (e) {
          state.messages = { errors: [String(e.message || e)], infos: [] };
        } finally {
          setBusy(false);
          render();
        }
      }
      function switchSide(side) {
        if (state.busy || side === state.side) return;
        state.side = side;
        const remembered = core2.storage.get(lastKey(side));
        if (remembered && state.resources.some((r) => r.id === remembered)) state.activeId = remembered;
        state.orders = [];
        state.updatedAt = null;
        state.messages = { errors: [], infos: [] };
        try {
          history.replaceState(null, "", marketPageUrl(side, mode));
        } catch (e) {
        }
        render();
        if (side === "buyer") maybeFetchUpkeep();
        loadAndSweep(state.activeId);
      }
      core2.addStyle(`
            #clop-market-root .clop-side-tabs { margin-bottom: 12px; }
            #clop-market-root .clop-side-tabs > li > a { cursor: pointer; }
            #clop-market-root .clop-tabs { margin: 8px 0; }
            #clop-market-root .clop-tabs > li > a { padding: 4px 10px; cursor: pointer; }
            #clop-market-root .clop-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 12px; margin-bottom: 8px; }
            #clop-market-root .clop-toolbar .clop-spacer { flex: 1; }
            #clop-market-root .clop-place { margin: 8px 0 12px 0; }
            #clop-market-root .clop-place .form-control { width: 110px; display: inline-block; }
            #clop-market-root td { vertical-align: middle !important; }
            #clop-market-root .clop-row-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
            #clop-market-root .clop-row-actions form { margin: 0; display: flex; align-items: center; gap: 6px; }
            #clop-market-root .clop-buyn { width: 150px; }
            #clop-market-root .clop-amount-note { white-space: nowrap; }
            #clop-market-root .clop-tabsbar { display: flex; align-items: flex-start; gap: 10px; }
            #clop-market-root .clop-tabsbar .clop-tabs { flex: 1; }
            #clop-market-root .clop-filter-toggle { white-space: nowrap; font-weight: normal; cursor: pointer; margin: 12px 0 0 0; }
            #clop-market-root .clop-filter-toggle input { margin-right: 4px; }
            #clop-market-root .clop-help { cursor: pointer; margin-top: 12px; }
            #clop-market-root .clop-friendly-badge { margin-left: 6px; }
            #clop-market-root .clop-form-row { display: flex; align-items: flex-start; gap: 10px; }
            #clop-market-root .clop-form-row .clop-place { flex: 1; }
            #clop-market-root .clop-form-row > button { margin-top: 8px; white-space: nowrap; }
            #clop-market-root.clop-busy .clop-action { pointer-events: none; opacity: .55; }
            #clop-market-root .clop-updated { font-size: 85%; }
        `);
      const content = document.getElementById("content");
      const root = el("div", { id: "clop-market-root" });
      function multiplierNote() {
        const buyPct = Math.round((state.mult.buy - 1) * 1e3) / 10;
        const sellPct = Math.round((1 - state.mult.sell) * 1e3) / 10;
        return state.side === "sell" ? `You pay ${buyPct}% over listed prices; you receive ${sellPct}% less when your listings sell.` : `You pay ${buyPct}% extra when offering to buy; you receive ${sellPct}% less when selling to an offer.`;
      }
      function render() {
        root.textContent = "";
        root.classList.toggle("clop-busy", state.busy);
        root.appendChild(el("ul", { class: "nav nav-tabs clop-side-tabs" }, SIDES.map(({ side, label, hint }) => el("li", { class: state.side === side ? "active clop-action" : "clop-action" }, [
          el("a", { title: hint, onclick: () => switchSide(side) }, [label])
        ]))));
        root.appendChild(el("div", { class: "well well-sm clop-toolbar" }, [
          el("span", {}, ["Funds: ", el("span", { class: "text-success" }, [state.funds || "?"])]),
          el("span", { class: "text-muted", title: multiplierNote() }, [
            `buy ×${state.mult.buy.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} / sell ×${state.mult.sell.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`
          ]),
          el("span", { class: "clop-spacer" }),
          el("span", { class: "text-muted clop-updated" }, [
            state.updatedAt ? `updated ${state.updatedAt.toLocaleTimeString()}` : "not loaded yet"
          ]),
          el("button", {
            class: "btn btn-default btn-sm clop-action",
            type: "button",
            onclick: () => loadAndSweep(state.activeId)
          }, ["⟳ Refresh"])
        ]));
        for (const [cls, list] of [["danger", state.messages.errors], ["info", state.messages.infos]]) {
          for (const html of list) {
            const alert = el("div", { class: `alert alert-${cls} alert-dismissible` });
            alert.appendChild(el("button", {
              class: "close",
              type: "button",
              html: "&times;",
              onclick: () => alert.remove()
            }));
            alert.appendChild(el("span", { html }));
            root.appendChild(alert);
          }
        }
        const hasDna = state.resources.some((r) => isDna(r.name));
        const visible = state.resources.filter((r) => r.id === state.activeId || state.favs.has(r.id) || !state.favsOnly && (state.showDna || !isDna(r.name)));
        const tabs = el("ul", { class: "nav nav-pills clop-tabs" });
        for (const r of visible) {
          const label = r.have ? `${r.name} (${core2.commas(r.have)})` : r.name;
          const a = el("a", { onclick: () => load(r.id) }, [label]);
          const badge = badgeFor(r.id);
          if (badge) a.appendChild(badge);
          tabs.appendChild(el("li", {
            class: r.id === state.activeId ? "active clop-action" : "clop-action",
            "data-rid": r.id
          }, [a]));
        }
        if (!visible.length) {
          tabs.appendChild(el("li", { class: "text-muted" }, [
            el("a", {}, ["No favourite markets yet — open one and hit ☆."])
          ]));
        }
        const tabsBar = el("div", { class: "clop-tabsbar" }, [tabs]);
        const favsCb = el("input", {
          type: "checkbox",
          onchange: (ev) => {
            state.favsOnly = ev.target.checked;
            core2.storage.set(FAVS_ONLY_KEY, state.favsOnly ? "1" : "0");
            render();
          }
        });
        favsCb.checked = state.favsOnly;
        tabsBar.appendChild(el("label", { class: "text-muted clop-filter-toggle" }, [favsCb, " favourites only"]));
        tabsBar.appendChild(el("a", {
          class: "clop-help clop-action",
          title: "Favourite markets are re-fetched on refresh to count alliance/friend orders. Click for details.",
          onclick: () => {
            state.showHelp = !state.showHelp;
            render();
          }
        }, ["(?)"]));
        if (!state.favsOnly && hasDna) {
          const dnaCb = el("input", {
            type: "checkbox",
            onchange: (ev) => {
              state.showDna = ev.target.checked;
              core2.storage.set(SHOW_DNA_KEY, state.showDna ? "1" : "0");
              render();
            }
          });
          dnaCb.checked = state.showDna;
          tabsBar.appendChild(el("label", { class: "text-muted clop-filter-toggle" }, [dnaCb, " show DNA"]));
        }
        root.appendChild(tabsBar);
        if (state.showHelp) {
          const help = el("div", { class: "alert alert-info" });
          help.appendChild(el("button", {
            class: "close",
            type: "button",
            html: "&times;",
            onclick: () => {
              state.showHelp = false;
              render();
            }
          }));
          help.appendChild(el("span", {}, [
            "Tab badges count the open orders of your alliance mates and friends (the green/blue names) on this side of the market: 68(2) means two of them are trading 68 units in total. Only ★ favourite markets and the currently open one are counted. Each favourite costs one extra server request on every load and view change, so try not to spam the server."
          ]));
          root.appendChild(help);
        }
        if (!state.activeId) {
          root.appendChild(el("div", { class: "alert alert-info" }, ["Pick a resource above to view its market."]));
          return;
        }
        root.appendChild(el("div", { class: "clop-form-row" }, [renderPlaceForm(), favButton()]));
        root.appendChild(renderOrders());
      }
      function badgeFor(id) {
        if (id !== state.activeId && !state.favs.has(id)) return null;
        const f = state.friendly[state.side][id];
        if (!f || !f.count) return null;
        const what = state.side === "sell" ? "selling" : "buying";
        return el("span", {
          class: "badge clop-friendly-badge",
          title: `${f.count} alliance/friend order${f.count === 1 ? "" : "s"} ${what} ${core2.commas(f.amount)} total`
        }, [`${core2.commas(f.amount)} (${f.count})`]);
      }
      function updateBadges() {
        for (const li of root.querySelectorAll(".clop-tabs li[data-rid]")) {
          const a = li.querySelector("a");
          const old = a.querySelector(".clop-friendly-badge");
          if (old) old.remove();
          const badge = badgeFor(li.getAttribute("data-rid"));
          if (badge) a.appendChild(badge);
        }
      }
      function favButton() {
        const fav = state.favs.has(state.activeId);
        return el("button", {
          class: `btn btn-sm ${fav ? "btn-warning" : "btn-default"} clop-action`,
          type: "button",
          title: fav ? "Stop counting alliance/friend orders for this market" : "Count alliance/friend orders for this market on every load and refresh",
          onclick: () => {
            if (fav) state.favs.delete(state.activeId);
            else state.favs.add(state.activeId);
            saveFavs();
            render();
          }
        }, [fav ? "★ Unfavourite Market" : "☆ Favourite Market"]);
      }
      function renderPlaceForm() {
        const sell = state.side === "sell";
        const qty = el("input", { class: "form-control", placeholder: "Qty" });
        const price = el("input", { class: "form-control", placeholder: "Bits each" });
        const note = el("span", { class: "text-muted" });
        const updateNote = () => {
          const q = parseInt(qty.value, 10), p = parseInt(price.value, 10);
          if (!(q > 0) || !(p > 0)) {
            note.textContent = "";
            return;
          }
          note.textContent = sell ? ` — ${core2.commas(Math.floor(p * q * state.mult.sell))} bits if it all sells` : ` — costs ${core2.commas(Math.floor(p * q * state.mult.buy))} bits now (refunded if you remove the offer)`;
        };
        qty.addEventListener("input", updateNote);
        price.addEventListener("input", updateNote);
        return el("form", {
          class: "form-inline clop-place clop-action",
          onsubmit: (ev) => {
            ev.preventDefault();
            if (!/^\d+$/.test(qty.value.trim()) || !/^\d+$/.test(price.value.trim())) {
              state.messages = { errors: ["Digits only- no commas, periods, or other markers."], infos: [] };
              render();
              return;
            }
            run(() => adapter().createOrder(state.activeId, qty.value.trim(), price.value.trim()));
          }
        }, [
          sell ? "Place " : "Offer to buy ",
          qty,
          ` ${resourceName(state.activeId)} at `,
          price,
          " ",
          el("button", { class: `btn ${sell ? "btn-success" : "btn-info"}`, type: "submit" }, [
            sell ? "Place on Market" : "Offer to Buy"
          ]),
          note
        ]);
      }
      function renderOrders() {
        if (!state.orders.length) {
          const msg = state.updatedAt ? state.side === "sell" ? "That item is not on the market." : "Nobody wants to buy that item." : "Not loaded yet — hit Refresh.";
          return el("div", { class: "alert alert-warning" }, [msg]);
        }
        const thead = el("thead", {}, [el("tr", {}, (state.side === "sell" ? ["Unit Price", "Units Available", "Seller", "Actions"] : ["Offering", "Amount Wanted", "Buyer", "Actions"]).map((h) => el("th", {}, [h])))]);
        const tbody = el("tbody");
        state.orders.forEach((order, idx) => tbody.appendChild(renderOrderRow(order, idx)));
        return el("table", { class: "table table-striped table-bordered table-condensed" }, [thead, tbody]);
      }
      function renderOrderRow(order, idx) {
        const sell = state.side === "sell";
        const priceCell = el("td", {}, [el("span", { class: "text-danger" }, [core2.commas(order.price)])]);
        const unit = (mult) => core2.commas(Math.floor(order.price * mult));
        const total = (mult) => core2.commas(Math.floor(order.price * order.amount * mult));
        let hint;
        if (order.own) {
          hint = sell ? `you get ${unit(state.mult.sell)} ea. / ${total(state.mult.sell)} for all` : `you pay ${unit(state.mult.buy)} ea. / ${total(state.mult.buy)} for all (escrowed)`;
        } else {
          hint = sell ? `you pay ${unit(state.mult.buy)} ea.` : `you get ${unit(state.mult.sell)} ea.`;
        }
        priceCell.appendChild(el("div", {}, [el("small", { class: "text-muted" }, [hint])]));
        const actions = el("div", { class: "clop-row-actions clop-action" });
        if (order.own) {
          actions.appendChild(el("button", {
            class: "btn btn-danger btn-sm",
            type: "button",
            onclick: () => run(() => adapter().cancelOrder(order))
          }, ["Remove from Marketplace"]));
        } else if (sell) {
          actions.appendChild(el("button", {
            class: "btn btn-primary btn-sm",
            type: "button",
            onclick: () => run(() => adapter().takeOrder(order, "one"))
          }, ["Buy One"]));
          actions.appendChild(el("button", {
            class: "btn btn-warning btn-sm",
            type: "button",
            onclick: () => run(() => adapter().takeOrder(order, "all"))
          }, [`Buy All (${total(state.mult.buy)} bits)`]));
          actions.appendChild(amountForm(
            "Buy:",
            "btn-success",
            (n) => run(() => adapter().takeOrder(order, n)),
            (n) => `pay ${core2.commas(Math.floor(order.price * n * state.mult.buy))} bits`
          ));
        } else {
          actions.appendChild(el("button", {
            class: "btn btn-primary btn-sm",
            type: "button",
            onclick: () => run(() => adapter().takeOrder(order, "one"))
          }, ["Sell One"]));
          actions.appendChild(sellAllButton(order));
          if (!mode) actions.appendChild(sellMaxButton(order));
          actions.appendChild(amountForm(
            "Sell:",
            "btn-success",
            (n) => run(() => adapter().takeOrder(order, n)),
            (n) => `get ${core2.commas(Math.floor(order.price * n * state.mult.sell))} bits`
          ));
        }
        return el("tr", { "data-idx": String(idx) }, [
          priceCell,
          el("td", {}, [el("span", { class: "text-success" }, [core2.commas(order.amount)])]),
          el("td", { html: order.ownerHtml }),
          el("td", {}, [actions])
        ]);
      }
      function sellAllButton(order) {
        const have = ownedAmount(order.resourceId);
        const up = upkeepFor(order.resourceId);
        const bits = Math.floor(order.price * order.amount * state.mult.sell);
        const btn = el("button", {
          class: "btn btn-warning btn-sm clop-sellall",
          type: "button",
          onclick: () => run(() => adapter().takeOrder(order, "all"))
        }, [`Sell All (${core2.commas(bits)} bits)`]);
        if (have < order.amount) {
          btn.disabled = true;
          btn.title = `You only have ${core2.commas(have)}`;
        } else if (up && have - reserveOf(up) < order.amount) {
          btn.disabled = true;
          btn.title = `Selling all ${core2.commas(order.amount)} would eat into your reserve of ${core2.commas(reserveOf(up))} (${reserveText(up)}) — use Sell Max`;
        }
        return btn;
      }
      function sellMaxButton(order) {
        const have = ownedAmount(order.resourceId);
        const up = upkeepFor(order.resourceId);
        const btn = el("button", { class: "btn btn-info btn-sm clop-sellmax", type: "button" }, []);
        if (!up) {
          btn.textContent = "Sell Max (…)";
          btn.disabled = true;
          btn.title = state.upkeep ? "No upkeep data for this resource on the Overview page" : "Fetching upkeep from the Overview page…";
          return btn;
        }
        const reserve = reserveOf(up);
        const max = Math.min(have - reserve, order.amount);
        if (max < 1) {
          btn.textContent = "Sell Max";
          btn.disabled = true;
          btn.title = `Nothing to spare: you have ${core2.commas(have)} and keep ${core2.commas(reserve)} back (${reserveText(up)})`;
        } else if (have - reserve > order.amount) {
          btn.textContent = `Sell Max (${core2.commas(max)}: ${core2.commas(Math.floor(order.price * max * state.mult.sell))} bits)`;
          btn.disabled = true;
          btn.title = `You can spare ${core2.commas(have - reserve)} — more than this whole order; use Sell All`;
        } else {
          btn.textContent = `Sell Max (${core2.commas(max)}: ${core2.commas(Math.floor(order.price * max * state.mult.sell))} bits)`;
          btn.title = `Sell everything above your reserve of ${core2.commas(reserve)} (${reserveText(up)}); re-verified before selling`;
          btn.addEventListener("click", () => sellMax(order, { reserve, n: max }, btn));
        }
        return btn;
      }
      function updateSellMaxUi() {
        if (state.side !== "buyer" || mode) return;
        for (const tr of root.querySelectorAll("tr[data-idx]")) {
          const order = state.orders[Number(tr.getAttribute("data-idx"))];
          if (!order || order.own) continue;
          const oldAll = tr.querySelector(".clop-sellall");
          if (oldAll) oldAll.replaceWith(sellAllButton(order));
          const oldMax = tr.querySelector(".clop-sellmax");
          if (oldMax) oldMax.replaceWith(sellMaxButton(order));
        }
      }
      function amountForm(label, btnClass, onAmount, preview) {
        const input = el("input", { class: "form-control input-sm", value: "1", type: "text" });
        const note = el("small", { class: "text-muted clop-amount-note" });
        const updateNote = () => {
          const n = parseInt(input.value, 10);
          note.textContent = preview && /^\d+$/.test(input.value.trim()) && n > 0 ? preview(n) : "";
        };
        input.addEventListener("input", updateNote);
        updateNote();
        return el("form", {
          onsubmit: (ev) => {
            ev.preventDefault();
            if (!/^\d+$/.test(input.value.trim())) return;
            onAmount(input.value.trim());
          }
        }, [
          el("div", { class: "input-group input-group-sm clop-buyn" }, [
            el("span", { class: "input-group-btn" }, [
              el("button", { class: `btn btn-sm ${btnClass}`, type: "submit" }, [label])
            ]),
            input
          ]),
          note
        ]);
      }
      function setBusy(b) {
        state.busy = b;
        root.classList.toggle("clop-busy", b);
      }
      hideStockMarketUi(content);
      content.insertBefore(root, stockUiInsertionPoint(content));
      render();
      if (state.side === "buyer") maybeFetchUpkeep();
      if (state.activeId && !state.updatedAt) loadAndSweep(state.activeId);
      else sweepFavourites();
    }
  };

  // src/main.js
  core.register(marketplaceModule);
  core.boot();
  window.CLOPUS = core;
})();
