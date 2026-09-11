import { affordabilityShortage, upkeepRiskForChange } from './upkeep-safety.js';
import { projectSatisfactionChange } from './action-safety.js';

export const NORMAL_TICKS_PER_WARTICK = 6;

// cron/frequent.php: resource upkeep at 00:00 and 12:00 UTC; satisfaction
// ceil((SUM(size) - 20) / 2) at EVERY normal tick. Includes deployed forces.
export function armySatisfactionPenalty(size) {
    return Math.max(0, Math.ceil((size - 20) / 2));
}

export function nextWartick(now = Date.now()) {
    const interval = 12 * 60 * 60 * 1000;
    const at = Math.ceil(now / interval) * interval;
    const minutes = Math.floor((at - now) / 60000);
    return { at, label: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
}

export function projectForceCreation(type, size, mercenaries, armySize, stats, satisfactionMode) {
    if (![size, armySize, size + armySize].every(Number.isSafeInteger) || size < 1 || armySize < 0) {
        throw new Error('Force size cannot be calculated safely.');
    }
    const relation = mercenaries === 'se' ? stats.seRelation : stats.nlrRelation;
    if (mercenaries && (!['se', 'nlr'].includes(mercenaries) || !Number.isFinite(relation))) {
        throw new Error('Could not read the relationship needed to price mercenaries.');
    }
    // Round the final payment up for an integral-bit affordability comparison.
    const required = Math.ceil(type.bitsCost * (mercenaries ? 3 - relation / 1000 : 1) * size);
    const reserveChange = type.upkeep.amount * size;
    if (![required, reserveChange].every(Number.isSafeInteger) || required < 0 || reserveChange < 0) {
        throw new Error('Force cost or upkeep cannot be calculated safely.');
    }
    if (!Number.isSafeInteger(stats.funds)) throw new Error('Could not read current funds.');
    const affordability = [affordabilityShortage({ qty: stats.funds }, required, 'Bits')].filter(Boolean);
    const key = type.upkeep.name.toLowerCase();
    const current = stats.byName[key] || { name: type.upkeep.name, qty: 0, used: 0, mil: 0, net: 0, generated: 0 };
    const risks = [upkeepRiskForChange(current, { reserveChange })].filter(Boolean);
    const netBefore = current.net - current.mil / NORMAL_TICKS_PER_WARTICK;
    const netAfter = netBefore - reserveChange / NORMAL_TICKS_PER_WARTICK;
    const resourceRateRisks = current.generated > 0 && netAfter < 0 && netAfter < netBefore
        ? [{ name: current.name, netBefore, netAfter,
            note: 'military upkeep averaged over 6 normal ticks' }] : [];
    const satisfactionProjection = projectSatisfactionChange(stats, {
        perTickChange: armySatisfactionPenalty(armySize) - armySatisfactionPenalty(armySize + size),
        satisfactionMode,
    });
    if (!satisfactionProjection) throw new Error('Could not calculate military satisfaction.');
    return { affordability, risks, resourceRateRisks, satisfactionProjection };
}
