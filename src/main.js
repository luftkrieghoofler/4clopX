import { core } from './core.js';
import { navbarModule } from './ui/navbar.js';
import { marketplaceModule } from './ui/marketplace.js';

core.register(navbarModule);
core.register(marketplaceModule);
core.boot();

// Debug handle; also lets ad-hoc modules register from the console.
window.CLOPUS = core;
