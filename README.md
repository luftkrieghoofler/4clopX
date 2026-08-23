# CLOP Dynamic UI userscript

A userscript that progressively replaces parts of the CLOP web UI with a dynamic,
fetch-based client. The server code is not modified; the script talks to the
existing PHP endpoints and parses their HTML responses, so it works against the
live instance even where values (prices, resources, multipliers) differ from the
reference source — everything is read from the pages, nothing is hardcoded.

## Install

Load `clop.user.js` into Violentmonkey / Tampermonkey. It matches
`https://4clop.org/*`, `https://*.4clop.org/*`, and `http(s)://localhost/*`
(the docker-compose dev instance). Add an extra `@match` line if your instance
lives elsewhere.

## Architecture

One file, two layers:

- **Core** — a tiny module framework plus shared services:
  - `Core.register({name, matches(page, location), init(core)})` — modules opt
    into pages; `Core.boot()` runs the matching ones. Future UI replacements
    are added as further `Core.register(...)` blocks (or separate files that
    call `window.CLOPUS.register` before boot on their own pages).
  - `Core.http.postForm(url, params)` — form-encoded POST returning a parsed
    `Document`. **Strictly serialized** (promise chain): the game's single-use
    tokens make concurrent POSTs self-defeating.
  - `Core.el / addStyle / commas` — DOM helpers.
- **Module: `marketplace`** — runs on `marketplace.php` and
  `buyermarketplace.php` in all three modes (resources / `?mode=weapons` /
  `?mode=armor`, which share the same pages server-side).

## The marketplace module

Replaces the resource `<select>` + full-page-reload flow with:

- resource **tabs** ("Name (owned)" labels parsed from the server's option
  list) — switching tabs fetches that market dynamically; DNA resources are
  hidden behind a "show DNA" toggle (persisted in `localStorage`);
- a **Refresh** button (impossible in the old UI — see token notes below);
- dynamic **buy / sell / list / remove** actions that re-render funds, owned
  counts, and the order list from the server's response;
- effective-price hints per row (what *you* pay/get after your economic-type
  multipliers, parsed off the page): per-unit on others' rows, "each / for
  all" on your own listings and offers; totals on the Buy All / Sell All
  buttons; live bit previews next to the custom-amount inputs and on the
  place/offer form; Sell All is disabled when you don't own enough;
- last-viewed resource remembered per market/mode in `localStorage` and
  auto-loaded on next visit.

Everything is re-parsed from each POST response (token, funds, alerts,
"(Have N)" counts, deal rows), so the UI always reflects the server's state
after an action, including error messages like "Somepony else bought the last
one!".

## Server protocol notes (from the reference PHP source)

Relevant files: `backend/backend_marketplace.php`, `backend/backend_buyermarketplace.php`.

### The token

`$_SESSION["token_<market>"]` is a single-use anti-double-submit token, one per
market table (`marketplace`, `weaponsmarketplace`, `armormarketplace`, and the
three `*buyermarketplace` variants — so the two pages/three modes never clash
with each other):

- every POST must send it as `token_<market>`;
- **every POST rotates it** to `sha1(rand() . old)`, even when validation
  fails; a GET only creates it if missing;
- every rendered page embeds the current token in its forms' hidden inputs.

This explains the old UI's quirks:

- browser refresh re-POSTs the already-consumed token → "Try again.";
- a plain GET shows no orders at all, because the deals query runs only
  `if ($_POST)`.

Consequences the script exploits:

- "loading" a market = POST `{token, mode, resource_id}` with no action verb;
- after any POST we harvest the fresh token from the response, enabling
  unlimited chained requests and a real Refresh button;
- on "Try again." (e.g. a second browser tab consumed the token) nothing was
  executed server-side (all mutations sit inside `if (!$errors)`), and the
  error response already carries the *new* token — so the script transparently
  retries once.

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

Deals are keyed server-side by `(nation_id, resource_id, price)` — that's why
rows carry the counterparty nation id and unit price rather than an order id.

### Response parsing

Responses are full HTML pages; the script extracts:

- fresh token: `input[name^="token_"]`;
- funds: the `.well` containing "Funds:";
- alerts: `.alert-danger div.error` / `.alert-info div.info` (the static
  economic-type alert has no `div.info` children, which is how it's told apart);
- deal rows: hidden inputs of each row's form (exact `resource_id`,
  counterparty id, raw `price`) + the `viewnation.php` anchor kept as-is so the
  server's friend/enemy/alliance coloring and region icons carry over;
- resource list + "Have" counts: the (hidden) `select[name=resource_id]` options.

A response with no `token_` input means the session died; the script surfaces
"reload and log in" instead of retrying.

## Adding a module

```js
window.CLOPUS.register({
    name: 'my-module',
    matches: (page) => page === 'somepage.php',
    init(core) { /* hide old widgets, render, use core.http.postForm(...) */ },
});
```

Register before `Core.boot()` runs (i.e. inside this file above the boot call,
or convert to `@require` parts later). Keep to the same pattern: parse state
from the live document, POST via the serialized queue, re-parse each response.
