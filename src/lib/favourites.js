// Per-side favourite market lists, stored as
// clopx.market.favs.<side>.<mode> (side: 'sell' | 'buyer'; mode '' is
// stored as "resources").  Shared by the marketplace UI (tab filters,
// badges, the ★ button) and the live-update sweep.

export const FAVOURITES_STORAGE_PREFIX = 'clopx.market.favs.';
const key = (side, mode) => `${FAVOURITES_STORAGE_PREFIX}${side}.${mode || 'resources'}`;

export function favouriteStorageChange(storageKey) {
    if (!storageKey || !storageKey.startsWith(FAVOURITES_STORAGE_PREFIX)) return null;
    const parts = storageKey.slice(FAVOURITES_STORAGE_PREFIX.length).split('.');
    if (parts.length !== 2) return null;
    const [side, storedMode] = parts;
    if (!['sell', 'buyer'].includes(side) || !['resources', 'weapons', 'armor'].includes(storedMode)) return null;
    return { side, mode: storedMode === 'resources' ? '' : storedMode };
}

// -> array of {id, name} (names let the settings panel label favourites on
// pages that have no resource list of their own)
export function readFavourites(side, mode) {
    try {
        const v = JSON.parse(localStorage.getItem(key(side, mode)) || '[]');
        return Array.isArray(v) ? v
            .filter((f) => f && typeof f === 'object' && f.id)
            .map((f) => ({ id: String(f.id), name: String(f.name || '') })) : [];
    } catch (e) {
        return [];
    }
}

export function favouriteIds(side, mode) {
    return readFavourites(side, mode).map((f) => f.id);
}

// favs: any iterable of {id, name}
export function writeFavourites(side, mode, favs) {
    try { localStorage.setItem(key(side, mode), JSON.stringify([...favs])); } catch (e) { /* ignore */ }
}

export function setFavourite(side, mode, market, on) {
    const id = String(market.id);
    const existing = readFavourites(side, mode);
    const without = existing.filter((f) => f.id !== id);
    const next = on ? [...without, { id, name: String(market.name || '') }] : without;
    writeFavourites(side, mode, sortByResourceOrder(mode, next));
    return next;
}

// Server-side resource order — the order of the marketplace <select>
// options, cached per mode and refreshed on every market page load.  It
// barely ever changes, so the cache is safe long-term; it's used to sort
// favourite lists the way the server lists resources.
const orderKey = (mode) => `clopx.market.resourceOrder.${mode || 'resources'}`;
export const MARKET_CATALOG_STORAGE_PREFIX = 'clopx.market.catalog.';
const catalogKey = (mode) => `${MARKET_CATALOG_STORAGE_PREFIX}${mode || 'resources'}`;

export function marketCatalogStorageMode(storageKey) {
    if (!storageKey || !storageKey.startsWith(MARKET_CATALOG_STORAGE_PREFIX)) return null;
    const storedMode = storageKey.slice(MARKET_CATALOG_STORAGE_PREFIX.length);
    if (!['resources', 'weapons', 'armor'].includes(storedMode)) return null;
    return storedMode === 'resources' ? '' : storedMode;
}

export function writeResourceOrder(mode, ids) {
    try { localStorage.setItem(orderKey(mode), JSON.stringify([...ids])); } catch (e) { /* ignore */ }
}

export function readResourceOrder(mode) {
    try {
        const v = JSON.parse(localStorage.getItem(orderKey(mode)) || '[]');
        return Array.isArray(v) ? v.map(String) : [];
    } catch (e) {
        return [];
    }
}

export function writeMarketCatalog(mode, resources) {
    const catalog = [...resources]
        .filter((r) => r && r.id)
        .map((r) => ({ id: String(r.id), name: String(r.name || '') }));
    try { localStorage.setItem(catalogKey(mode), JSON.stringify(catalog)); } catch (e) { /* ignore */ }
    writeResourceOrder(mode, catalog.map((r) => r.id));
}

export function readMarketCatalog(mode) {
    try {
        const value = JSON.parse(localStorage.getItem(catalogKey(mode)) || '[]');
        if (Array.isArray(value) && value.length) {
            return value.filter((r) => r && r.id)
                .map((r) => ({ id: String(r.id), name: String(r.name || '') }));
        }
    } catch (e) { /* fall through to the legacy order cache */ }

    // Before catalogues were stored, only the ordered IDs and names of
    // favourites were available.  Use those as a partial fallback; the
    // settings editor can then lazily refresh the complete catalogue.
    const names = new Map();
    for (const side of ['sell', 'buyer']) {
        for (const favourite of readFavourites(side, mode)) {
            if (favourite.name) names.set(String(favourite.id), favourite.name);
        }
    }
    return readResourceOrder(mode).map((id) => ({ id: String(id), name: names.get(String(id)) || '' }));
}

// Sort {id, name} entries into server resource order; ids the cache hasn't
// seen sort last, by name (which approximates the server's name ordering).
export function sortByResourceOrder(mode, favs) {
    const index = new Map(readResourceOrder(mode).map((id, i) => [id, i]));
    return [...favs].sort((a, b) => {
        const ai = index.has(a.id) ? index.get(a.id) : Infinity;
        const bi = index.has(b.id) ? index.get(b.id) : Infinity;
        if (ai !== bi) return ai - bi;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
}
