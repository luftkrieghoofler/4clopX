import { core } from './core.js';
import { marketplaceModule } from './ui/marketplace.js';

core.register(marketplaceModule);
core.boot();

// Debug handle; also lets ad-hoc modules register from the console.
window.CLOPUS = core;
