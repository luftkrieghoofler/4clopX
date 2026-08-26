import { core } from './core.js';
import { autologinModule } from './ui/autologin.js';
import { shortcutsModule } from './ui/shortcuts.js';
import { marketplaceModule } from './ui/marketplace.js';
import { actionsModule } from './ui/actions.js';
import { liveUpdatesModule } from './ui/liveupdates.js';
import { settingsModule } from './ui/settings.js';

// shortcuts before the other logged-in UI: it snapshots the unmodified stock
// menu for its destination picker, then listens for marketplace view events.
// liveupdates before marketplace: marketplace pages emit "live:pollNow"
// during init, so the listener must already exist.  settings last, so its
// panel sees every module's registered settings (and its ⚙ lands leftmost
// in the navbar group).
core.register(autologinModule);
core.register(shortcutsModule);
core.register(liveUpdatesModule);
core.register(marketplaceModule);
core.register(actionsModule);
core.register(settingsModule);
core.boot();

// Debug handle; also lets ad-hoc modules register from the console.  With
// GM grants the script runs in the manager's sandbox, so export to the real
// page window where possible.
try {
    (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).clopX = core;
} catch (e) {
    window.clopX = core;
}
