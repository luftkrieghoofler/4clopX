# CLOP Dynamic UI userscript

A userscript that progressively replaces parts of the CLOP web UI with a
dynamic, fetch-based client. The server code is not modified; the script talks
to the existing PHP endpoints and parses their HTML responses, so it works
against the live instance even where values (prices, resources, multipliers)
differ from the reference source — everything is read from the pages, nothing
is hardcoded.

## Build & install

```sh
npm install        # once; installs esbuild
npm run build      # src/ -> dist/clop.user.js
npm run watch      # rebuild on every source change
```

Load `dist/clop.user.js` into Violentmonkey / Tampermonkey. It matches
`https://4clop.org/*`, `https://*.4clop.org/*`, and `http(s)://localhost/*`
(the docker-compose dev instance); add a `@match` line in `src/meta.txt` if
your instance lives elsewhere.

Dev loop: run `npm run watch`, and in Violentmonkey install the script from
`file:///…/dist/clop.user.js` — it offers to track the file, so a page reload
picks up every rebuild. (Tampermonkey can do the same if you enable "Allow
access to file URLs" for the extension in the browser.)

## Project layout

```
build.mjs                 esbuild bundling: ESM in, one IIFE userscript out
src/
  meta.txt                the ==UserScript== header (single source of truth,
                          prepended verbatim; @version injected into the code)
  main.js                 entry point: registers modules, boots
  core.js                 module registry, serialized HTTP queue, DOM/storage
                          helpers — no page-specific knowledge
  adapters/
    market.js             everything that knows the server: token protocol,
                          POST vocabulary, HTML parsing, stock-page surgery
  ui/
    marketplace.js        merged marketplace frontend (pure UI)
dist/
  clop.user.js            build output — the file you install
```

Userscript managers can't load ES modules from disk, so multi-file userscripts
are bundled; esbuild is the light way to do it (the heavier ecosystem options
are `vite-plugin-monkey` / `webpack-userscript`, which add dev-server
hot-reload and header management — worth it if this grows a lot).

## Architecture: adapter vs frontend

The code is split so that the two likely kinds of change stay isolated:

- **`src/adapters/market.js`** is the only file that knows the site. It owns
  the token bookkeeping, the form-field vocabulary of both marketplace
  endpoints, all HTML parsing, and the "hide the stock widgets" surgery. If
  the site's markup drifts, the `parse*` functions here are the only thing to
  fix. If the dev ever ships a real API, a second adapter implementing the
  same interface replaces this one and the UI is untouched.
- **`src/ui/*.js`** never touches server HTML. The marketplace frontend calls
  the adapter interface and renders `MarketSnapshot` objects.

The adapter interface (one adapter instance per market side × mode):

```js
adapter = createMarketAdapter(core, kind /* 'sell'|'buyer' */, mode, seedDoc?)
adapter.ready()                              // ensure a token is held (GET-seeds if needed)
adapter.snapshotFromDocument(doc)            // boot state from the hosting page, no network
adapter.load(resourceId)                     // -> MarketSnapshot
adapter.createOrder(resourceId, amount, price)
adapter.takeOrder(order, 'one'|'all'|'<n>')  // buy from a listing / sell to an offer
adapter.cancelOrder(order)
```

```js
MarketSnapshot = {
  kind: 'sell'|'buyer',
  resourceId,                  // which resource `orders` belongs to
  funds,                       // display string
  mult: {buy, sell} | null,    // your economic-type multipliers
  resources: [{id, name, have, selected}],
  orders: [{resourceId, counterpartyId, price, amount, own, ownerHtml,
            relation /* 'friend'|'enemy'|'alliance'|null, from the server's
                        name styling; friend overrides alliance */}],
  messages: {errors: [html], infos: [html]},
}
```

## The merged marketplace

`marketplace.php` and `buyermarketplace.php` (plus their weapons/armor modes)
are now one UI with two top-level tabs, **Sell Orders** (listings you can buy
from) and **Buy Orders** (offers you can sell to). The stock Capitalism menu
items are left alone: both pages host the same UI, opened on the side the
visited page corresponds to, so the "Buyer's ..." entries still take you
straight to the buy side.

There is no custom "root page", because the script still needs a
server-rendered shell (session, header, nav) to live in. Switching sides never
navigates: the other endpoint is driven by its own adapter, and
`history.replaceState` swaps the URL between the two stock paths so refresh
and bookmarks land on the view you were on. The non-host side's token is
seeded lazily with one GET the first time you switch to it.

Features carried over from the single-page version: resource tabs with owned
counts and a DNA show/hide toggle, Refresh, dynamic buy/sell/place/remove,
effective-price hints (per-unit, own-order "each / for all", Buy All / Sell
All totals, live previews on custom amounts), Sell All disabled when you own
too few, last-viewed resource remembered per side and mode.

### Alliance/friend badges & favourite markets

Tabs can carry a `[total(orders)]` badge counting the open orders of alliance
mates and friends on the current side — e.g. `Apples (48) [68(2)]`: you own
48, and two green/blue-named players are trading 68 in total. "Friendly" means
the server's own name styling: green (`text-success`) is alliance,
blue (`text-info`) is friends — and since friend styling *overrides* alliance
styling server-side, both colors are counted so alliance mates you've
friended aren't missed. Own orders are excluded.

Counting a market costs one POST, so badges are only maintained for markets
you mark as **★ favourites** (button next to the place/offer form, stored per
mode) plus the currently open market (whose counts come free with every
response). Favourites are re-fetched — one request each, through the same
serialized queue — on page load, Refresh, and side switches; market tab
clicks deliberately don't sweep (opening a market refreshes its own badge
anyway, and an explicit Refresh covers the rest). A newer sweep or side
switch aborts an older one, and there is deliberately no caching. Favourite tabs (DNA ones included)
are always visible; the "favourites only" toggle next to the DNA toggle hides
everything else. The `(?)` link explains the semantics in-page and warns
against favouriting too many markets (each one is an extra request per
refresh).

## Server protocol notes (from the reference PHP source)

Relevant files: `backend/backend_marketplace.php`, `backend/backend_buyermarketplace.php`.

### The token

`$_SESSION["token_<market>"]` is a single-use anti-double-submit token, one per
market table (`marketplace`, `weaponsmarketplace`, `armormarketplace`, and the
three `*buyermarketplace` variants — so the two sides/three modes never clash
with each other):

- every POST must send it as `token_<market>`;
- **every POST rotates it** to `sha1(rand() . old)`, even when validation
  fails; a GET only creates it if missing;
- every rendered page embeds the current token in its forms' hidden inputs.

This explains the old UI's quirks:

- browser refresh re-POSTs the already-consumed token → "Try again.";
- a plain GET shows no orders at all, because the deals query runs only
  `if ($_POST)`.

Consequences the adapter exploits:

- "loading" a market = POST `{token, mode, resource_id}` with no action verb;
- after any POST it harvests the fresh token from the response, enabling
  unlimited chained requests and a real Refresh button;
- a GET seeds the token for a market the user hasn't visited this session
  (used for the non-host side of the merged UI);
- on "Try again." (e.g. a second browser tab consumed the token) nothing was
  executed server-side (all mutations sit inside `if (!$errors)`), and the
  error response already carries the *new* token — so the adapter
  transparently retries once.

### Request vocabulary

Common fields: `token_<market>`, `mode` (`""` | `weapons` | `armor`), `resource_id`.

`marketplace.php` (submit name is always `action`):

| action                    | extra fields                          |
|---------------------------|---------------------------------------|
| *(none — just list)*      | —                                     |
| `Place on Market`         | `amount`, `price`                     |
| `Buy One` / `Buy All`     | `buyingfrom_id`, `price`              |
| `Buy:`                    | `buyingfrom_id`, `price`, `buyingamount` |
| `Remove from Marketplace` | `buyingfrom_id`, `price`              |

`buyermarketplace.php` (distinct submit names):

| field=value                      | extra fields                          |
|----------------------------------|---------------------------------------|
| *(none — just list)*             | —                                      |
| `offer=Offer to Buy`             | `amount`, `price` (funds escrowed immediately) |
| `sellone=Sell One` / `sellall=Sell All` | `sellingto_id`, `price`         |
| `sellamount=Sell:`               | `sellingto_id`, `price`, `sellingamount` |
| `remove=Remove from Marketplace` | `sellingto_id`, `price` (escrow refunded) |

Orders are keyed server-side by `(nation_id, resource_id, price)` — that's why
rows carry the counterparty nation id and unit price rather than an order id.

### Response parsing

Responses are full HTML pages; the adapter extracts:

- fresh token: `input[name^="token_"]`;
- funds: the `.well` containing "Funds:";
- alerts: `.alert-danger div.error` / `.alert-info div.info` (the static
  economic-type alert has no `div.info` children, which is how it's told apart);
- order rows: hidden inputs of each row's form (exact `resource_id`,
  counterparty id, raw `price`) + the `viewnation.php` anchor kept as-is so the
  server's friend/enemy/alliance coloring and region icons carry over; the
  coloring classes inside that anchor also yield each order's `relation`
  (`text-info` friend / `text-danger` enemy / `text-success` alliance —
  checked in the server's own precedence order);
- resource list + "Have" counts: the (hidden) `select[name=resource_id]` options.

A response with no `token_` input means the session died; the adapter surfaces
"reload and log in" instead of retrying.

## Adding a module

Create `src/ui/<name>.js` exporting `{name, matches(page, location), init(core)}`,
register it in `src/main.js`, rebuild. If it needs new server interactions,
give it an adapter in `src/adapters/` and keep the parsing there.
