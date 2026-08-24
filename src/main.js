import { core } from './core.js';
import { autologinModule } from './ui/autologin.js';
import { marketplaceModule } from './ui/marketplace.js';
import { liveUpdatesModule } from './ui/liveupdates.js';

// liveupdates before marketplace: marketplace pages emit "live:pollNow"
// during init, so the listener must already exist.
core.register(autologinModule);
core.register(liveUpdatesModule);
core.register(marketplaceModule);
core.boot();

// Debug handle; also lets ad-hoc modules register from the console.  With
// GM grants the script runs in the manager's sandbox, so export to the real
// page window where possible.
try {
    (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).clopX = core;
} catch (e) {
    window.clopX = core;
}
