// Per-side favourite market lists, stored as
// clopx.market.favs.<side>.<mode> (side: 'sell' | 'buyer'; mode '' is
// stored as "resources").  Shared by the marketplace UI (tab filters,
// badges, the ★ button) and the live-update sweep.

const key = (side, mode) => `clopx.market.favs.${side}.${mode || 'resources'}`;

// -> array of resource ids
export function readFavourites(side, mode) {
    try {
        const v = JSON.parse(localStorage.getItem(key(side, mode)) || '[]');
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
}

// ids: any iterable of resource ids
export function writeFavourites(side, mode, ids) {
    try { localStorage.setItem(key(side, mode), JSON.stringify([...ids])); } catch (e) { /* ignore */ }
}
