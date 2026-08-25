# 4clopX - CLOP Dynamic UI userscript

A userscript for [CLOP](https://4clop.org) that replaces the marketplace with a dynamic single-page UI, adds optional auto-login and live refresh polling with desktop notification.

## Install

Install a userscript manager (Violentmonkey, Tampermonkey, or Greasemonkey), then install [`clop.user.js` from the latest release](https://github.com/luftkrieghoofler/4clopX/releases/latest/download/clop.user.js). Updates arrive through the manager's normal update check. To build from source instead, see [DEVELOPMENT.md](DEVELOPMENT.md).

## What changes

Live updates and notifications: the stock notifications - messages, alliance, deals, incoming attacks, polls - refresh periodically without reloading the page, and support desktop notifications. Click on the the timer in the navbar to refresh immediately.

Marketplace (resources, weapons, and armor modes):

- Sell orders and buy orders become one page with two tabs. Switching sides, switching resources, buying, selling, placing and removing orders all happen in place, without page loads. The stock menu entries still work and open the side they always led to.
- No more "Try again." on refresh; there is a proper Refresh button, and page reload works seamlessly in the market.
- Resource tabs have a toggle to hide DNA resources and one to show ★ favourites only, to declutter the amount of tabs.
- Prices are shown as what you'll actually pay or receive (your economic-type multipliers applied), including live totals for Buy All / Sell All and custom amounts. Sell listings can be priced per item or from a desired total after tax.
- When selling to buy orders, your upkeep is protected: the sell button is an orange **Sell All** when you can fill the whole order, and turns into a blue **Sell Max** selling exactly your spare stock when filling it all would cut into your upkeep.
- Orders from outside your alliance and friends can be shown normally, faded, or hidden; your own orders always remain visible.
- Tabs can show how much alliance mates and friends are trading in each ★ favourite market you 👁 watch. These get auto-refreshed with the live update timer and can generate desktop notifications.
- The last-viewed resource is remembered per side.

Auto-login (opt-in): when the game expires your session, the script logs you back in and takes you to the page you were trying to open instead of the login screen.

## More info

**Favourite markets.** A badge like `[2 (68)]` on a resource tab means alliance mates (green names) and friends (blue names) have 2 open orders totalling 68 units in that market, on the current side. Keeping a badge up to date costs one extra request per refresh, so badges are only maintained for 👁 watched markets — chosen in the ⚙ settings among your ★ favourites; watch the few you actually follow. Other markets refresh when you open their tab. Favourite tabs and the currently open market always stay visible — favouriting a DNA market is also how you keep it around while "show DNA" is off; in favourites-only mode the DNA toggle is disabled since favourites are always shown. The `(?)` link next to the star explains the details in-page.

**Sell All / Sell Max.** The script reserves your upkeep — the per-tick "Used" amounts from the Overview plus the military's 12-hour resource consumption — when selling into buy orders. When your stock is insufficient to cover the entire order, the **Sell All** buttons turns into **Sell Max (N: X bits)** that sells only what you can spare. Obviously, if you plan on building more buildings on your nation within the same tick, don't sell off your entire stockpile as you won't be left with anything to spare for the new buildings!

**Auto-login.** Tick "Auto-login (remember credentials)" on the login form to enable it; logging in with it unticked erases the stored credentials. They are kept in the userscript manager's script-private storage, which site scripts (including any XSS on the site) cannot read — but on disk they are unencrypted, like most browser-stored data. That's probably fine, but bear it in mind if you're security-minded or already use a password manager. After a "Login incorrect." response the feature disables itself (the server rate-limits failed logins) until you log in manually with the checkbox ticked again.

**Live updates.** Checks every 30 seconds while some game tab is visible and every 2 minutes otherwise (configurable in settings). If the login session expires in the background, the check logs back in using the stored auto-login credentials, or stops (the navbar timer shows ✖) if there are none - so auto-login is useful for reliable notifications. The blue menu badges count alliance/friend orders across watched markets. By default buy-order favourites are watched (the orders you can sell into) and sell listings are not; this can be changed per market in the ⚙ settings; a currently open market tab is also live-updated.
