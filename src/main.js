import { core } from './core.js';
import { dialogsModule } from './ui/dialogs.js';
import { feedbackModule } from './ui/feedback.js';
import { autologinModule } from './ui/autologin.js';
import { shortcutsModule } from './ui/shortcuts.js';
import { overviewModule } from './ui/overview.js';
import { marketplaceModule } from './ui/marketplace.js';
import { actionsModule } from './ui/actions.js';
import { dealsModule } from './ui/deals.js';
import { liveUpdatesModule } from './ui/liveupdates.js';
import { settingsModule } from './ui/settings.js';

// shortcuts before the other logged-in UI: it snapshots the unmodified stock
// menu for its destination picker, then listens for marketplace view events.
// overview before liveupdates: it snapshots the untouched stock Overview DOM
// before live badges/actions annotate it.  liveupdates before marketplace:
// marketplace pages emit "live:pollNow" during init, so the listener must
// already exist.  settings last, so its panel sees every module's registered
// settings (and its ⚙ lands leftmost in the navbar group).
core.register(dialogsModule);
core.register(feedbackModule);
core.register(autologinModule);
core.register(shortcutsModule);
core.register(overviewModule);
core.register(liveUpdatesModule);
core.register(marketplaceModule);
core.register(actionsModule);
core.register(dealsModule);
core.register(settingsModule);
// Keep core private: exporting it to the page also exposes its privileged
// secret-storage methods (including access to saved login credentials).
core.boot();
