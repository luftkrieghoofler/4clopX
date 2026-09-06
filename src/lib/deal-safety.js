import { affordabilityShortage, upkeepRiskForChange } from './upkeep-safety.js';
import { ACTION_CATALOG, BUILDING_UPKEEP } from '../data/actions.generated.js';

// Overview omits resources with no stock, production, or consumption. Known
// resource names let us recognize that zero without misclassifying weapons
// and armor, whose requested tables also say "Requested Items".
const knownResourceNames = new Set([
    ...Object.values(ACTION_CATALOG).flatMap((action) => [...action.items, action.output]
        .filter((item) => item && !item.isBuilding)),
    ...Object.values(BUILDING_UPKEEP).flat(),
].map((item) => item.name.toLowerCase()));

function add(map, name, amount) {
    const key = name.toLowerCase();
    const current = map.get(key) || { name, amount: 0 };
    current.amount += amount;
    map.set(key, current);
}

export function projectDealAffordability(deal, stats) {
    if (!deal || !stats || !stats.byName) return [];
    const requested = new Map();
    for (const item of deal.requested || []) add(requested, item.name, item.amount);
    const shortages = [];
    for (const [key, item] of requested) {
        // Offered items are credited after the server validates the request.
        const current = stats.byName[key] || (knownResourceNames.has(key) ? { qty: 0 } : null);
        const shortage = affordabilityShortage(current, item.amount, item.name);
        if (shortage) shortages.push(shortage);
    }
    return shortages.sort((a, b) => a.name.localeCompare(b.name));
}

// Project the final resource stock after both sides of an incoming deal.
// Unrecognized rows are weapons/armor (the stock page labels their requested
// tables "Requested Items" too), so only names present in Overview resources
// participate in resource-upkeep protection.
export function projectDealRisks(deal, stats) {
    if (!deal || !stats || !stats.byName) return [];
    const changes = new Map();
    for (const item of deal.offered || []) add(changes, item.name, item.amount);
    for (const item of deal.requested || []) {
        add(changes, item.name, -item.amount);
    }

    const risks = [];
    for (const [key, change] of changes) {
        const current = stats.byName[key];
        if (!current || !Number.isSafeInteger(change.amount)) continue;
        const risk = upkeepRiskForChange(current, {
            name: current.name || change.name,
            stockChange: change.amount,
        });
        if (risk) risks.push(risk);
    }
    return risks.sort((a, b) => a.name.localeCompare(b.name));
}
