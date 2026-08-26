export function normalizeActionText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

export function actionCompatibility(actual, expected) {
    if (!expected) return { status: 'unknown', differences: ['No catalogue data exists'] };

    const differences = [];
    if (normalizeActionText(actual.name) !== normalizeActionText(expected.name)) {
        differences.push('name');
    }
    if (normalizeActionText(actual.description) !== normalizeActionText(expected.description)) {
        differences.push('description');
    }
    return { status: differences.length ? 'changed' : 'verified', differences };
}

function add(map, key, amount) {
    map.set(key, (map.get(key) || 0) + amount);
}

function keyed(stats, collection, name) {
    return stats && stats[collection] ? stats[collection][name.toLowerCase()] || null : null;
}

export function actionNeedsSafetyCheck(action, buildingUpkeep) {
    if (!action) return false;
    if (action.items.some((item) => item.consumed && !item.isBuilding)) return true;
    return !!(action.output && action.output.isBuilding
        && (buildingUpkeep[action.output.resourceId] || []).length);
}

// Project only immediate inventory changes and the reserve required after the
// action. Per-tick production is deliberately not treated as inventory: CLOP
// requires upkeep to be present at the beginning of the tick.
export function projectActionRisks(action, times, stats, buildingUpkeep) {
    if (!action || !Number.isSafeInteger(times) || times < 1) return [];

    const stockDelta = new Map();
    const reserveDelta = new Map();
    const displayNames = new Map();
    const removedActive = new Map();
    const remember = (name) => displayNames.set(name.toLowerCase(), name);

    for (const item of action.items) {
        if (!item.consumed) continue;
        if (!item.isBuilding) {
            remember(item.name);
            add(stockDelta, item.name.toLowerCase(), -(item.amount * times));
            continue;
        }

        const key = item.name.toLowerCase();
        const building = keyed(stats, 'buildingsByName', item.name);
        const alreadyRemoved = removedActive.get(key) || 0;
        const active = Math.max(0, Number(building && building.active) || 0);
        const remove = Math.min(Math.max(0, active - alreadyRemoved), item.amount * times);
        removedActive.set(key, alreadyRemoved + remove);
        for (const requirement of buildingUpkeep[item.resourceId] || []) {
            remember(requirement.name);
            add(reserveDelta, requirement.name.toLowerCase(), -(requirement.amount * remove));
        }
    }

    if (action.output) {
        if (action.output.isBuilding) {
            const built = action.output.amount * times;
            for (const requirement of buildingUpkeep[action.output.resourceId] || []) {
                remember(requirement.name);
                add(reserveDelta, requirement.name.toLowerCase(), requirement.amount * built);
            }
        } else {
            remember(action.output.name);
            add(stockDelta, action.output.name.toLowerCase(), action.output.amount * times);
        }
    }

    const keys = new Set([...stockDelta.keys(), ...reserveDelta.keys()]);
    const risks = [];
    for (const key of keys) {
        const current = keyed(stats, 'byName', key) || { qty: 0, used: 0, mil: 0 };
        const stockBefore = Number(current.qty) || 0;
        const reserveBefore = (Number(current.used) || 0) + (Number(current.mil) || 0);
        const stockChange = stockDelta.get(key) || 0;
        const reserveChange = reserveDelta.get(key) || 0;
        const stockAfter = stockBefore + stockChange;
        const reserveAfter = Math.max(0, reserveBefore + reserveChange);

        // Warn if this action leaves the resource unsafe and is responsible
        // for making its stock or reserve worse. An unrelated action should
        // not nag merely because a resource was already below upkeep.
        if (stockAfter < reserveAfter && (stockChange < 0 || reserveChange > 0)) {
            risks.push({
                name: current.name || displayNames.get(key) || key,
                stockBefore,
                stockAfter,
                stockChange,
                reserveBefore,
                reserveAfter,
                reserveChange,
                shortage: reserveAfter - stockAfter,
            });
        }
    }
    return risks.sort((a, b) => a.name.localeCompare(b.name));
}
