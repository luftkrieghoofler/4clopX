import { upkeepRiskForChange } from './upkeep-safety.js';

function add(map, name, amount) {
    const key = name.toLowerCase();
    const current = map.get(key) || { name, amount: 0 };
    current.amount += amount;
    map.set(key, current);
}

// Project the final resource stock after both sides of an incoming deal.
// Unrecognized rows are weapons/armor (the stock page labels their requested
// tables "Requested Items" too), so only names present in Overview resources
// participate in resource-upkeep protection.
export function projectDealRisks(deal, stats) {
    if (!deal || !stats || !stats.byName) return [];
    const changes = new Map();
    const requested = new Map();
    for (const item of deal.offered || []) add(changes, item.name, item.amount);
    for (const item of deal.requested || []) {
        add(changes, item.name, -item.amount);
        add(requested, item.name, item.amount);
    }

    const risks = [];
    for (const [key, change] of changes) {
        const current = stats.byName[key];
        if (!current || !Number.isSafeInteger(change.amount)) continue;
        const stockBefore = Number(current.qty) || 0;

        // An unaffordable requested item makes the server reject the deal;
        // offered resources are credited only after that validation.
        const requestedAmount = requested.get(key);
        if (requestedAmount && requestedAmount.amount > stockBefore) continue;
        const risk = upkeepRiskForChange(current, {
            name: current.name || change.name,
            stockChange: change.amount,
        });
        if (risk) risks.push(risk);
    }
    return risks.sort((a, b) => a.name.localeCompare(b.name));
}
