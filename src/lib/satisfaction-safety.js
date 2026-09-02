// Government-specific satisfaction limits used by both action safety and
// the live Overview buffer. CLOP checks for rebels only below (not at) the
// threshold, after applying the tick's satisfaction change.

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

// Number of complete safe ticks before the projected satisfaction would be
// below the government's rebel limit. null means the current trend does not
// lead to rebels; zero means the next tick is already unsafe.
export function satisfactionTicksWorth(status) {
    if (!status) return null;
    const satisfaction = Number(status.satisfaction);
    const perTick = Number(status.satisfactionPerTick);
    const rebelThreshold = REBEL_SATISFACTION_THRESHOLDS[status.government];
    if (![satisfaction, perTick, rebelThreshold].every(Number.isFinite)) return null;

    if (perTick < 0) {
        return Math.max(0, Math.floor((satisfaction - rebelThreshold) / Math.abs(perTick)));
    }
    // A nation already below its threshold still faces rebels unless this
    // tick's recovery reaches the safe side of the limit.
    return satisfaction + perTick < rebelThreshold ? 0 : null;
}
