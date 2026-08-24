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
