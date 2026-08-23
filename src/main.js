import { core } from './core.js';
import { autologinModule } from './ui/autologin.js';
import { marketplaceModule } from './ui/marketplace.js';

core.register(autologinModule);
core.register(marketplaceModule);
core.boot();

// Debug handle; also lets ad-hoc modules register from the console.  With
// GM grants the script runs in the manager's sandbox, so export to the real
// page window where possible.
try {
    (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).CLOPUS = core;
} catch (e) {
    window.CLOPUS = core;
}
