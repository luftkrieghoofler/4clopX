import { equipmentForceSize, equipmentOptionStock } from '../adapters/military.js';

// No asynchronous work when opening a native dropdown. Inventory snapshots
// can arrive at any time, but an open/focused select keeps its options stable
// until blur. Unknown inventory never disables choices.
export function createEquipmentOptions(doc = document) {
    const records = new Map();
    let snapshot = null;

    function render(select, record) {
        if (doc.activeElement === select) return;
        const inventory = snapshot?.[record.key];
        for (const [option, original] of record.options) {
            if (!option.value) continue; // Scrounged / unequip is always available.
            const item = inventory?.[original.name.toLowerCase()];
            const stock = inventory ? (item ? item.qty : 0) : original.qty;
            const known = stock !== null && Number.isSafeInteger(stock) && record.size !== null;
            option.disabled = known && stock < record.size && option.value !== record.equipped;
            option.textContent = `${original.name}${known ? ` (Have ${stock} extra)` : ''}`;
        }
        updateSubmit(select, record);
    }

    function updateSubmit(select, record) {
        const unavailable = [...select.options].some((option) => option.selected && option.disabled);
        for (const [button, title] of record.buttons) {
            button.disabled = unavailable;
            button.title = unavailable ? 'Not enough spare equipment for this force. Choose another option.' : title;
        }
    }

    function bind() {
        for (const [select] of records) if (!select.isConnected) records.delete(select);
        for (const select of doc.querySelectorAll('form select[name="weapon_id"], form select[name="armor_id"]')) {
            if (records.has(select)) {
                render(select, records.get(select));
                continue;
            }
            const record = {
                key: select.name === 'weapon_id' ? 'weaponsByName' : 'armorByName',
                size: equipmentForceSize(select.form), equipped: select.value,
                options: new Map([...select.options].map((option) => [option, equipmentOptionStock(option.textContent)])),
                buttons: new Map([...select.form.querySelectorAll('input[type="submit"], button[type="submit"]')]
                    .map((button) => [button, button.title])),
            };
            records.set(select, record);
            select.addEventListener('blur', () => render(select, record));
            select.addEventListener('change', () => updateSubmit(select, record));
            render(select, record);
        }
    }

    return {
        bind,
        update(stats) {
            if (!stats || (snapshot && stats.at < snapshot.at)) return;
            snapshot = stats;
            for (const [select, record] of records) render(select, record);
        },
        // A POST response has newer inventory than the last shared snapshot.
        reset() { snapshot = null; records.clear(); bind(); },
    };
}
