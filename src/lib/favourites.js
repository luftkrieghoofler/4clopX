// Per-side favourite market lists, stored as
// clopx.market.favs.<side>.<mode> (side: 'sell' | 'buyer'; mode '' is
// stored as "resources").  Shared by the marketplace UI (tab filters,
// badges, the ★ button) and the live-update sweep.

const key = (side, mode) => `clopx.market.favs.${side}.${mode || 'resources'}`;

// -> array of {id, name} (names let the settings panel label favourites on
// pages that have no resource list of their own)
export function readFavourites(side, mode) {
    try {
        const v = JSON.parse(localStorage.getItem(key(side, mode)) || '[]');
        return Array.isArray(v) ? v.filter((f) => f && typeof f === 'object' && f.id) : [];
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

// Server-side resource order — the order of the marketplace <select>
// options, cached per mode and refreshed on every market page load.  It
// barely ever changes, so the cache is safe long-term; it's used to sort
// favourite lists the way the server lists resources.
const orderKey = (mode) => `clopx.market.resourceOrder.${mode || 'resources'}`;

export function writeResourceOrder(mode, ids) {
    try { localStorage.setItem(orderKey(mode), JSON.stringify([...ids])); } catch (e) { /* ignore */ }
}

export function readResourceOrder(mode) {
    try {
        const v = JSON.parse(localStorage.getItem(orderKey(mode)) || '[]');
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
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
