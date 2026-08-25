import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    favouriteStorageChange, marketCatalogStorageMode, readFavourites,
    readMarketCatalog, readResourceOrder, setFavourite, writeMarketCatalog,
} from '../src/lib/favourites.js';

const previousStorage = globalThis.localStorage;
const values = new Map();

globalThis.localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
};

beforeEach(() => values.clear());
after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
});

test('stores a named market catalogue while preserving server order', () => {
    writeMarketCatalog('', [
        { id: '2', name: 'Coffee' },
        { id: '1', name: 'Apples' },
    ]);

    assert.deepEqual(readMarketCatalog(''), [
        { id: '2', name: 'Coffee' },
        { id: '1', name: 'Apples' },
    ]);
    assert.deepEqual(readResourceOrder(''), ['2', '1']);
});

test('uses legacy ordered IDs and favourite names until a catalogue is available', () => {
    values.set('clopx.market.resourceOrder.resources', JSON.stringify(['1', '2']));
    values.set('clopx.market.favs.sell.resources', JSON.stringify([{ id: '2', name: 'Coffee' }]));

    assert.deepEqual(readMarketCatalog(''), [
        { id: '1', name: '' },
        { id: '2', name: 'Coffee' },
    ]);
});

test('adds, updates, and removes favourites without duplicates', () => {
    writeMarketCatalog('', [
        { id: '1', name: 'Apples' },
        { id: '2', name: 'Coffee' },
    ]);

    setFavourite('buyer', '', { id: '2', name: 'Coffee' }, true);
    setFavourite('buyer', '', { id: '2', name: 'Coffee beans' }, true);
    setFavourite('buyer', '', { id: '1', name: 'Apples' }, true);
    assert.deepEqual(readFavourites('buyer', ''), [
        { id: '1', name: 'Apples' },
        { id: '2', name: 'Coffee beans' },
    ]);

    setFavourite('buyer', '', { id: '1', name: 'Apples' }, false);
    assert.deepEqual(readFavourites('buyer', ''), [{ id: '2', name: 'Coffee beans' }]);
});

test('recognises favourite and catalogue storage changes', () => {
    assert.deepEqual(favouriteStorageChange('clopx.market.favs.sell.resources'), { side: 'sell', mode: '' });
    assert.deepEqual(favouriteStorageChange('clopx.market.favs.buyer.weapons'), { side: 'buyer', mode: 'weapons' });
    assert.equal(favouriteStorageChange('clopx.market.friendly'), null);
    assert.equal(marketCatalogStorageMode('clopx.market.catalog.resources'), '');
    assert.equal(marketCatalogStorageMode('clopx.market.catalog.armor'), 'armor');
    assert.equal(marketCatalogStorageMode('clopx.market.resourceOrder.resources'), null);
});
