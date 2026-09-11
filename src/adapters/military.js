import { normalizeActionText } from '../lib/action-safety.js';
import { BUILDING_EFFECTS } from '../data/actions.generated.js';

const buildingNames = new Map(Object.entries(BUILDING_EFFECTS)
    .map(([id, effect]) => [effect.name.toLowerCase(), Number(id)]));

function whole(text) {
    const value = String(text).trim();
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(value)) return null;
    const n = Number(value.replace(/,/g, ''));
    return Number.isSafeInteger(n) ? n : null;
}

// Unlike ordinary Actions, equipment requirements are generated as one
// database item per <br>, not prose. Reject any unrecognised description
// rather than silently dropping part of a changed recipe.
export function equipmentRecipeFromForm(form) {
    const row = form.closest('tr');
    const paragraph = row?.querySelector('.col-md-6 p');
    const cost = whole(row?.querySelector('.text-danger')?.textContent);
    const name = normalizeActionText(paragraph?.querySelector('b')?.textContent);
    if (!paragraph || cost === null || !name) throw new Error('Equipment recipe layout was not recognised.');
    const lines = [''];
    for (const node of paragraph.childNodes) {
        if (node.nodeName === 'BR') lines.push('');
        else lines[lines.length - 1] += node.textContent || '';
    }
    if (normalizeActionText(lines.shift()) !== name) throw new Error('Equipment recipe heading changed.');
    return equipmentRecipeFromLines(name, cost, lines);
}

export function equipmentRecipeFromLines(name, bitsCost, lines) {
    const items = [];
    for (const raw of lines) {
        const line = normalizeActionText(raw);
        if (!line) continue;
        const prerequisite = line.match(/^\(Requires ([\d,]+) (.+)\)$/);
        const match = prerequisite || line.match(/^([\d,]+) (.+)$/);
        const amount = match ? whole(match[1]) : null;
        if (amount === null) throw new Error(`Unrecognised equipment requirement: ${line}`);
        const resourceId = buildingNames.get(match[2].toLowerCase());
        items.push({ name: match[2], amount, consumed: !prerequisite,
            isBuilding: resourceId !== undefined, resourceId });
    }
    return { name, bitsCost, items, output: null, satisfaction: 0 };
}

// Prices/upkeep are displayed in the Create Forces table. Read the live
// values so a numeric rebalance does not silently use old costs.
export function forceTypesFromDocument(doc) {
    const types = new Map();
    for (const row of doc.querySelectorAll('#content tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length !== 3) continue;
        const name = normalizeActionText(cells[0].textContent);
        const bitsCost = whole(cells[1].textContent);
        const upkeep = normalizeActionText(cells[2].textContent)
            .match(/^([\d,]+) ([a-z ]+)\/12 hours$/i);
        if (bitsCost === null || !upkeep || whole(upkeep[1]) === null) continue;
        types.set(name, { name, bitsCost,
            upkeep: { name: upkeep[2], amount: whole(upkeep[1]) } });
    }
    return types;
}

// Group Forces includes ALL owned units (including away/in-transit); the
// Overview and Equip Forces lists do not. Deduplicate its many per-row forms.
export function armySizeFromDocument(doc) {
    const sizes = new Map();
    for (const input of doc.querySelectorAll('form input[name="force_id"]')) {
        const row = input.closest('tr');
        const match = row?.textContent.match(/\bSize:\s*([\d,]+)\s*Training:/);
        const size = match ? whole(match[1]) : null;
        if (size === null) throw new Error('Could not read a force size.');
        sizes.set(input.value, size);
    }
    if (!sizes.size && !doc.querySelector('#content')?.textContent.includes('You have no forces to group!')) {
        throw new Error('Could not find the complete army list.');
    }
    const total = [...sizes.values()].reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(total)) throw new Error('Army size is too large to calculate safely.');
    return total;
}

export function equipmentOptionStock(text) {
    const match = normalizeActionText(text).match(/^(.*?) \(Have ([\d,]+) extra\)$/);
    return match ? { name: match[1], qty: whole(match[2]) }
        : { name: normalizeActionText(text), qty: 0 };
}

export function equipmentForceSize(form) {
    const match = form.closest('tr')?.textContent.match(/\bSize:\s*([\d,]+)\s*Training:/);
    return match ? whole(match[1]) : null;
}
