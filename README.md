# CLOP Dynamic UI userscript

A userscript for [CLOP](https://4clop.org) that replaces the marketplace with
a dynamic single-page UI and adds optional auto-login.

## Install

Install a userscript manager (Violentmonkey, Tampermonkey, or Greasemonkey),
then install
[`clop.user.js` from the latest release](https://github.com/luftkrieghoofler/4clopX/releases/latest/download/clop.user.js).
Updates arrive through the manager's normal update check. To build from
source instead, see [DEVELOPMENT.md](DEVELOPMENT.md).

## What changes

Marketplace (resources, weapons, and armor modes):

- Sell orders and buy orders become one page with two tabs. Switching sides,
  switching resources, buying, selling, placing and removing orders all
  happen in place, without page loads. The stock menu entries still work and
  open the side they always led to.
- No more "Try again." on refresh; there is a proper Refresh button.
- Resource tabs show how much of each resource you own, with a toggle to
  hide DNA resources and one to show favourites only.
- Prices are shown as what you'll actually pay or receive (your economic-type
  multipliers applied), including live totals for Buy All / Sell All and
  custom amounts.
- When selling to buy orders, your upkeep is protected: **Sell All** is
  disabled when filling the order would cut into it, and a **Sell Max**
  button sells exactly your spare stock instead.
- Tabs can show how much alliance mates and friends are trading in each
  market you mark as a ★ favourite.
- The last-viewed resource is remembered per side.

Auto-login (opt-in): when the game expires your session, the script logs you
back in and takes you to the page you were trying to open instead of the
login screen.

## Notes

**Favourite markets.** A badge like `[68(2)]` on a resource tab means
alliance mates (green names) and friends (blue names) have 2 open orders
totalling 68 units in that market, on the current side. Keeping a badge up
to date costs one extra request per refresh, so badges are only maintained
for the market you have open plus the ones you star as favourites — star the
few you actually watch. Favourite tabs also stay visible when the
DNA-hiding or favourites-only filters are on. The `(?)` link next to the
star explains the details in-page.

**Sell All / Sell Max.** The script reserves your upkeep — the per-tick
"Used" amounts from the Overview plus the military's 12-hour resource
consumption — when selling into buy orders. Sell All is disabled when
filling the whole order would eat into that reserve; Sell Max sells only
your spare stock, and is disabled when the spare stock covers the entire
order (Sell All then does the same thing). Sell Max re-checks the Overview
when clicked and aborts if the numbers have changed in the meantime.

**Auto-login.** Tick "Auto-login (remember credentials)" on the login form
to enable it; logging in with it unticked erases the stored credentials.
They are kept in the userscript manager's script-private storage, which site
scripts (including any XSS on the site) cannot read — but on disk they are
unencrypted, like most browser-stored data. That's probably fine, but bear
it in mind if you're security-minded or already use a password manager.
After a "Login incorrect." response the feature disables itself (the server
rate-limits failed logins) until you log in manually with the checkbox
ticked again.
