// Government-specific satisfaction limits used by both action safety and
// the live Overview buffer. CLOP checks for rebels only below (not at) the
// threshold, after applying the tick's satisfaction change.

export const NATION_COLLAPSE_THRESHOLD = -5000;

// CLOP scales both the satisfaction cap and the three high-satisfaction
// decay bands by the same government multiplier.  Governments not listed
// here use the server's default 1, including all of the low-cap governments.
export const SATISFACTION_MULTIPLIERS = Object.freeze({
    Transponyism: 7,
    'Alicorn Elite': 5,
    Independence: 2.5,
    Decentralization: 2,
    Democracy: 1.5,
    'Solar Vassal': 1.25,
    'Lunar Client': 1.25,
});

export const MAX_SATISFACTION_DECAY = 30;

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

export function satisfactionMultiplier(government) {
    return SATISFACTION_MULTIPLIERS[government] || 1;
}

// Mirror backend_overview.php / cron/frequent.php.  The displayed
// satisfaction/tick value includes this temporary penalty, which shrinks as
// satisfaction falls and is therefore not an ongoing structural deficit.
export function satisfactionDecayPenalty(satisfaction, government) {
    const value = Number(satisfaction);
    if (!Number.isFinite(value)) return 0;
    const multiplier = satisfactionMultiplier(government);
    let penalty = 0;
    for (const start of [250, 500, 750]) {
        const threshold = start * multiplier;
        if (value > threshold) {
            penalty += Math.floor((value - threshold) / (50 * multiplier));
        }
    }
    return penalty;
}

export function satisfactionPerTickWithoutDecay(status) {
    if (!status || status.satisfaction === null || status.satisfaction === undefined
        || status.satisfactionPerTick === null
        || status.satisfactionPerTick === undefined) return null;
    const displayed = Number(status.satisfactionPerTick);
    const satisfaction = Number(status.satisfaction);
    if (![displayed, satisfaction].every(Number.isFinite)) return null;
    return displayed + satisfactionDecayPenalty(satisfaction, status.government);
}

// Number of complete safe ticks before the projected satisfaction would be
// below the government's rebel limit. null means the current trend does not
// lead to rebels; zero means the next tick is already unsafe.
export function satisfactionTicksWorth(status) {
    if (!status || status.satisfaction === null || status.satisfaction === undefined) return null;
    const satisfaction = Number(status.satisfaction);
    // Always ignore high-satisfaction decay here.  It disappears long before
    // satisfaction approaches a rebel threshold, so projecting the currently
    // displayed rate forever would manufacture a danger that cannot occur.
    const perTick = satisfactionPerTickWithoutDecay(status);
    const rebelThreshold = REBEL_SATISFACTION_THRESHOLDS[status.government];
    if (![satisfaction, perTick, rebelThreshold].every(Number.isFinite)) return null;

    if (perTick < 0) {
        return Math.max(0, Math.floor((satisfaction - rebelThreshold) / Math.abs(perTick)));
    }
    // A nation already below its threshold still faces rebels unless this
    // tick's recovery reaches the safe side of the limit.
    return satisfaction + perTick < rebelThreshold ? 0 : null;
}
