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

export const NATION_COLLAPSE_THRESHOLD = -5000;

export const REBEL_SATISFACTION_THRESHOLDS = Object.freeze({
    'Loose Despotism': -100,
    'Solar Vassal': -100,
    'Lunar Client': -100,
    Democracy: 0,
    Repression: -300,
    Independence: 0,
    Decentralization: 0,
    Oppression: -500,
    Authoritarianism: -400,
    'Alicorn Elite': -500,
    Transponyism: -500,
});

function effectNeedsProjection(effect) {
    return !!effect && (
        !!effect.satisfaction || !!effect.badMin || effect.environmentalCleaner
        || (effect.production || []).length > 0
    );
}

export function effectiveActionTimes(action, times, stats) {
    if (!action || !Number.isSafeInteger(times) || times < 1) return 0;
    if (!Number.isSafeInteger(action.maxOwned) || !action.output || !action.output.isBuilding) return times;
    const owned = keyed(stats, 'buildingsByName', action.output.name);
    const remaining = Math.max(0, action.maxOwned - (Number(owned && owned.qty) || 0));
    return Math.min(times, remaining);
}

export function actionNeedsSafetyCheck(action, buildingUpkeep, buildingEffects = {}) {
    if (!action) return false;
    if (action.items.some((item) => item.consumed && !item.isBuilding)) return true;
    if (Number(action.satisfaction) < 0) return true;
    if (action.items.some((item) => item.consumed && item.isBuilding
        && effectNeedsProjection(buildingEffects[item.resourceId]))) return true;
    return !!(action.output && action.output.isBuilding && (
        (buildingUpkeep[action.output.resourceId] || []).length
        || effectNeedsProjection(buildingEffects[action.output.resourceId])
    ));
}

// Project only immediate inventory changes and the reserve required after the
// action. Per-tick production is deliberately not treated as inventory: CLOP
// requires upkeep to be present at the beginning of the tick.
export function projectActionRisks(action, times, stats, buildingUpkeep) {
    if (!action || !Number.isSafeInteger(times) || times < 1) return [];

    // Some actions have a hard owned-building limit. Mirror the server's
    // effective build count so a request for several does not exaggerate
    // costs/upkeep when only the remaining allowance can be built.
    times = effectiveActionTimes(action, times, stats);
    if (times < 1) return [];

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

        // The server rejects an unaffordable action instead of allowing a
        // resource to become negative, so a projected negative inventory is
        // not an upkeep risk the action can actually create.
        if (stockAfter < 0) continue;

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

function activeBuildingCounts(stats, buildingEffects) {
    const counts = new Map();
    for (const [resourceId, effect] of Object.entries(buildingEffects)) {
        const building = keyed(stats, 'buildingsByName', effect.name);
        counts.set(String(resourceId), Math.max(0, Number(building && building.active) || 0));
    }
    return counts;
}

function projectedBuildingCounts(action, times, stats, buildingEffects) {
    const effectiveTimes = effectiveActionTimes(action, times, stats);
    const before = activeBuildingCounts(stats, buildingEffects);
    const after = new Map(before);
    if (!effectiveTimes) return { effectiveTimes, before, after };

    for (const item of action.items) {
        if (!item.consumed || !item.isBuilding) continue;
        const key = String(item.resourceId);
        const remove = item.amount * effectiveTimes;
        after.set(key, Math.max(0, (after.get(key) || 0) - remove));
    }
    if (action.output && action.output.isBuilding) {
        const key = String(action.output.resourceId);
        after.set(key, (after.get(key) || 0) + action.output.amount * effectiveTimes);
    }
    return { effectiveTimes, before, after };
}

function buildingSatisfaction(counts, buildingEffects) {
    let base = 0;
    let environmentalDamage = 0;
    let environmentalCleaners = 0;

    for (const [resourceId, effect] of Object.entries(buildingEffects)) {
        const count = counts.get(String(resourceId)) || 0;
        base += count * (Number(effect.satisfaction) || 0);
        if (effect.environmentalCleaner) environmentalCleaners += count;
        if (effect.badMin && effect.badDiv && count > effect.badMin) {
            environmentalDamage += Math.ceil(((count - effect.badMin) ** 2) / effect.badDiv);
        }
    }

    const environmentalPenalty = environmentalDamage
        ? Math.ceil(environmentalDamage * (0.9 ** environmentalCleaners))
        : 0;
    return { base, environmentalDamage, environmentalCleaners, environmentalPenalty };
}

// Project the satisfaction effects caused by this action without attempting
// to simulate unrelated production chains. The Overview's current net rate
// remains the baseline; only building counts changed by the action are
// applied here, including nonlinear environmental damage and cleaners.
export function projectActionSatisfaction(action, times, stats, buildingEffects = {}) {
    if (!stats || stats.satisfaction === null || stats.satisfaction === undefined
        || stats.satisfactionPerTick === null || stats.satisfactionPerTick === undefined) return null;
    const satisfactionBefore = Number(stats && stats.satisfaction);
    const perTickBefore = Number(stats && stats.satisfactionPerTick);
    const { effectiveTimes, before: beforeCounts, after: afterCounts } =
        projectedBuildingCounts(action, times, stats, buildingEffects);
    if (!effectiveTimes || !Number.isFinite(satisfactionBefore) || !Number.isFinite(perTickBefore)) return null;

    const beforeBuildings = buildingSatisfaction(beforeCounts, buildingEffects);
    const afterBuildings = buildingSatisfaction(afterCounts, buildingEffects);
    const perTickChange = (afterBuildings.base - beforeBuildings.base)
        - (afterBuildings.environmentalPenalty - beforeBuildings.environmentalPenalty);
    const perTickAfter = perTickBefore + perTickChange;
    const immediateChange = (Number(action.satisfaction) || 0) * effectiveTimes;
    const satisfactionAfter = satisfactionBefore + immediateChange;
    const nextTickSatisfaction = satisfactionAfter + perTickAfter;
    const nextTickChange = immediateChange + perTickChange;
    if (![perTickChange, perTickAfter, immediateChange, satisfactionAfter,
        nextTickSatisfaction, nextTickChange]
        .every(Number.isSafeInteger)) return null;

    const rebelThreshold = REBEL_SATISFACTION_THRESHOLDS[stats.government];
    let hazard = null;
    // Do not nag about a pre-existing next-tick hazard unless this action is
    // responsible for making that next-tick outcome worse.
    if (nextTickChange < 0) {
        if (nextTickSatisfaction < NATION_COLLAPSE_THRESHOLD) hazard = 'collapse';
        else if (Number.isFinite(rebelThreshold) && nextTickSatisfaction < rebelThreshold) hazard = 'rebels';
    }

    return {
        times: effectiveTimes,
        satisfactionBefore,
        immediateChange,
        satisfactionAfter,
        perTickBefore,
        perTickChange,
        perTickAfter,
        nextTickSatisfaction,
        nextTickChange,
        rebelThreshold: Number.isFinite(rebelThreshold) ? rebelThreshold : null,
        hazard,
        trendRisk: perTickAfter < 0 && perTickChange < 0,
        environmentBefore: beforeBuildings,
        environmentAfter: afterBuildings,
    };
}

// Project only the resource-rate changes caused by buildings added or
// consumed by this action. The Overview's current Net column remains the
// baseline, preserving unrelated production, use, and stockpile loss.
export function projectActionResourceRates(action, times, stats, buildingUpkeep, buildingEffects = {}) {
    const { effectiveTimes, before, after } =
        projectedBuildingCounts(action, times, stats, buildingEffects);
    if (!effectiveTimes) return [];

    const productionDelta = new Map();
    const upkeepDelta = new Map();
    const displayNames = new Map();
    for (const [resourceId, effect] of Object.entries(buildingEffects)) {
        const countChange = (after.get(String(resourceId)) || 0) - (before.get(String(resourceId)) || 0);
        if (!countChange) continue;
        for (const production of effect.production || []) {
            const key = production.name.toLowerCase();
            displayNames.set(key, production.name);
            add(productionDelta, key, production.amount * countChange);
        }
        for (const requirement of buildingUpkeep[resourceId] || []) {
            const key = requirement.name.toLowerCase();
            displayNames.set(key, requirement.name);
            add(upkeepDelta, key, requirement.amount * countChange);
        }
    }

    const risks = [];
    const keys = new Set([...productionDelta.keys(), ...upkeepDelta.keys()]);
    for (const key of keys) {
        const current = keyed(stats, 'byName', key) || {};
        const generatedBefore = Number(current.generated) || 0;
        const usedBefore = Number(current.used) || 0;
        const netBefore = Number(current.net) || 0;
        const generatedAfter = generatedBefore + (productionDelta.get(key) || 0);
        const usedAfter = Math.max(0, usedBefore + (upkeepDelta.get(key) || 0));
        const netChange = (productionDelta.get(key) || 0) - (upkeepDelta.get(key) || 0);
        const netAfter = netBefore + netChange;
        if (![generatedAfter, usedAfter, netChange, netAfter].every(Number.isSafeInteger)) continue;

        // Imported resources naturally have a negative rate. Warn only when
        // there is domestic production before or after this action, and this
        // action is responsible for creating or worsening the deficit.
        if (netAfter < 0 && netChange < 0 && (generatedBefore > 0 || generatedAfter > 0)) {
            risks.push({
                name: current.name || displayNames.get(key) || key,
                generatedBefore,
                generatedAfter,
                usedBefore,
                usedAfter,
                netBefore,
                netAfter,
                netChange,
            });
        }
    }
    return risks.sort((a, b) => a.name.localeCompare(b.name));
}
