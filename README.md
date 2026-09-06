# 4clopX - CLOP Dynamic UI userscript

A userscript for [CLOP](https://4clop.org) to improve the UI.
 * Live updates and desktop notifications (for messages, deals, attacks, watched markets and more)
 * A completely overhauled marketplace UI - tabbed item views, in-place refreshing
 * A shortcut bar to easily access your most frequently used in-game pages, markets, etc. - save any game view as a shortcut!
 * Auto-login - if you choose to save your username and password in the script, seamlessly re-logs you when the game session expires
 * Safety checks for all actions (building, selling, etc.), showing a warning if you would put your nation in danger
    * Never accidentally burn 5x as much oil as you intended putting your nation in instakill range, ever again!
 * Stockpile monitoring and notifications when they run low

## Install

Install a userscript manager (e.g. Violentmonkey or Greasemonkey), then install [`clop.user.js` from the latest release](https://github.com/luftkrieghoofler/4clopX/releases/latest/download/clop.user.js). Updates arrive through the manager's normal update check.

On mobile, Firefox supports extensions and therefore userscripts.

To build from source instead, see [DEVELOPMENT.md](DEVELOPMENT.md).

## More info

### Live updates and notifications
Every 60s by default, the scripts checks the stock notifications (messages, alliance, incoming attacks etc.), watched markets, and resource usage; new events are show in the tab title and support desktop notifications. Click on the the timer in the navbar to refresh immediately.

If the game session expires in the background, auto-login is required to keep watching (see below). If autologin is disabled, don't rely on notifications, since sessions are relatively short-lived.

### Auto-login
If enabled (tick "Auto-login (remember credentials)" on the login form), when the game expires your session the script logs you back in and takes you to the page you were trying to open instead of the login screen.

Your username and password are kept in the userscript manager's script-private storage, which websites (including 4clop or other userscripts) cannot read; however, browser storage is saved on disk unencrypted, so it's not quite as secure as a real password manager. As mentioned above, enabling this is necessary for the live refresh polling to be able to log back in if the session expires.

The stored values can be deleted in the 4clopX settings, or by logging out and unchecking the "Auto-login" checkbox when logging in again.

### Shortcut bar
You can save frequently used destinations in a sticky row below the stock navigation, to avoid having to navigate submenus all the time. The 🔖 button saves the current view - any page is be supported, such as normal menu destinations (Reports, Actions, My Alliance...), links to view other nations or alliances, or even individual markets (e.g. Buy Apples). Shortcuts can be renamed and reordered from the shortcut manager in ⚙ settings.

### Safe actions
Most actions you can take - Actions, Favourite Actions, buying/selling on the market, accepting Deals, etc. - are checked against your current stock, upkeep, production, and satisfaction before they run. If completing the action would cause issues, such as eating into your upkeep for the next tick or making your nation unsustainable, you will be asked for confirmation before proceeding.

Most nation expansions, if done in the right build order, can be completed without clicking through almost any warnings; usually the only catch-22 that requires temporarily ignoring a warning is expanding energy infrastructure (since oil burners reduce satisfaction, but satisfaction buildings require energy). Other than this, almost all builds can be completed with peace of mind.

Also shows a special reminder for Burn Oil to prevent the classic mistake of burning 5x too much.

### Marketplace
The marketplace UI is completely overhauled:
 * Sell orders and buy orders become one page with two tabs, and every resource becomes a tab, making navigation much, much easier.
 * No more "Try again." on refresh; page reload works seamlessly in the market. (And the currently open view auto refreshes using the live update mechanism.)
 * Resource tabs have a toggle to hide DNA resources and one to show ★ favourites only, to declutter the amount of tabs.
 * Tooltips show the prices you'd actually pay or receive based on your economic type and tax rate. Sell listings can be priced per item or from a desired total after tax.
 * Similar to Safe Actions, when selling to buy orders, if you cannot fill the whole order the **Sell All** button turns into **Sell Max** to sell exactly your spare stock without cutting into your own upkeep for next tick. Obviously, don't rely on this if you plan to add more buildings to your nation before the next tick!
 * Orders from outside your alliance and friends can be shown normally, faded, or hidden; your own orders always remain visible.
 * Watched markets: by marking a favourite market as 👁 watched, it will be refreshed in the background at the Live Update schedule, and notifications will show how many orders your alliance mates and friends are trading in that market (with desktop notifications when new orders go up). A notification badge like `2 (68)` on a market tab means that there are 2 alliance/friend orders for a total of 68 items across them on that market. By default, resources that you have no more stock to safely sell show a greyed-out badge and no desktop notifications.

### Stockpile monitoring
By default, the Overview tab on your nation shows a yellow badge when any upkeep resource reaches 5 ticks remaining, and a red badge (with a desktop notification) when a single tick of upkeep is left. These values can be changed in the settings.
