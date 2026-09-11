import { formatTickDuration, tickIsCritical, tickIsImminent, tickSecondsFromDocument } from '../adapters/header.js';
import { SATISFACTION_SAFETY_MODES } from '../lib/action-safety.js';
import { upkeepWarningSection } from './upkeep-warning.js';
import { rateRiskListItem, warningGroup, warningSection } from './warning-content.js';
import { affordabilityDialogOptions } from './affordability-warning.js';

const IMMINENT_TICK_SECONDS = 10 * 60;
const CRITICAL_TICK_SECONDS = 90;
const BURN_OIL_UNITS_PER_ACTION = 5;

export function actionWarningGroup(core, {
    resourceRateRisks = [], risks = [], satisfactionTrend = null, burnOilReminder = false,
    wartick = null,
}) {
    const sections = [];
    if (resourceRateRisks.length) {
        sections.push(warningSection(core, 'Domestic production deficit',
            resourceRateRisks.map((risk) => rateRiskListItem(
                core, risk.name, risk.netBefore, risk.netAfter, risk.note || ''))));
    }
    sections.push(upkeepWarningSection(core, risks, wartick ? {
        heading: 'Insufficient stock for next wartick',
        horizon: 'next wartick',
        description: `Next wartick in ${wartick.label} (HH:mm; 00:00/12:00 UTC). Includes normal tick consumption plus the full military upkeep payment.`,
    } : {}));
    if (satisfactionTrend) {
        sections.push(warningSection(core, 'Satisfaction declining', [
            rateRiskListItem(core, 'Satisfaction', satisfactionTrend.perTickBefore,
                satisfactionTrend.perTickAfter,
                satisfactionTrend.satisfactionMode === SATISFACTION_SAFETY_MODES.MAXIMUM
                    ? 'at cap' : 'decay ignored'),
        ]));
    }
    if (burnOilReminder) {
        sections.push(warningSection(core, 'Remember: 1 action burns 5 oil', [
            core.el('li', {}, ['Divide the oil you intend to burn by 5 before entering the action count.']),
        ]));
    }
    return warningGroup(core, sections);
}

// Shared by ordinary recipes and military creation.
export function createActionSafetyDialogs(core) {
    const el = core.el.bind(core);
    core.addStyle(`
        .clop-action-tick-critical { border-width: 2px; font-size: 105%; }
        .clop-action-satisfaction-title { display: block; margin-bottom: 8px; }
        .clop-action-satisfaction-summary { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; }
        .clop-action-satisfaction-summary strong { font-size: 110%; }
        .clop-action-collapse-risk { border-width: 2px; }
        .clop-burn-oil-risk-suggestion { margin-top: 8px; }
    `);
    function actionConfirm(options) {
        const imminentHeadline = el('strong');
        const criticalSeconds = el('strong');
        const imminent = el('div', { class: 'alert alert-warning', style: 'display:none;' }, [
            imminentHeadline,
            el('div', {}, [
                'Wait until afterwards, or be ready to remedy the highlighted risk before then.',
            ]),
        ]);
        const critical = el('div', {
            class: 'alert alert-danger clop-action-tick-critical',
            style: 'display:none;',
        }, [
            el('strong', {}, [`${(options.tickName || 'tick').toUpperCase()} IS ABOUT TO HAPPEN`]),
            el('div', {}, [
                'Do not proceed unless you can remedy the highlighted risk within ', criticalSeconds, '.',
            ]),
        ]);
        const bodyChildren = Array.isArray(options.body) ? options.body : [options.body];
        const body = el('div', {}, [imminent, critical, ...bodyChildren]);

        function updateTickWarnings() {
            const untilTick = options.secondsUntilRisk
                ? options.secondsUntilRisk() : tickSecondsFromDocument(document);
            const tickRelevant = options.tickRelevant !== false;
            const showCritical = tickRelevant && tickIsCritical(untilTick, CRITICAL_TICK_SECONDS);
            const showImminent = tickRelevant && !showCritical
                && tickIsImminent(untilTick, IMMINENT_TICK_SECONDS);
            imminent.style.display = showImminent ? '' : 'none';
            critical.style.display = showCritical ? '' : 'none';
            if (showImminent) {
                imminentHeadline.textContent = `Next ${options.tickName || 'tick'} in ${formatTickDuration(untilTick)}.`;
            }
            if (showCritical) {
                criticalSeconds.textContent =
                    `${untilTick} second${untilTick === 1 ? '' : 's'}`;
            }
        }

        return core.confirm(affordabilityDialogOptions(core, options.affordability, {
            ...options,
            body,
            onOpen: () => {
                updateTickWarnings();
                const timer = setInterval(updateTickWarnings, 250);
                return () => clearInterval(timer);
            },
        }));
    }

    function signed(value) {
        return value > 0 ? `+${core.commas(value)}` : core.commas(value);
    }

    function riskConfirmation(action, times, risks, satisfactionProjection, {
        burnOil = null,
        showSatisfactionTrend = true,
        resourceRateRisks = [],
        affordability = [],
        wartick = null,
    } = {}) {
        const quantity = times === 1 ? action.name : `${action.name} × ${core.commas(times)}`;
        const body = [];
        const hazard = satisfactionProjection && satisfactionProjection.hazard;
        const satisfactionTrend = !!(showSatisfactionTrend && !hazard
            && satisfactionProjection && satisfactionProjection.trendRisk);
        if (hazard) {
            const collapse = hazard === 'collapse';
            const headline = collapse
                ? `THIS ${burnOil ? 'BURN' : 'ACTION'} WILL DESTROY YOUR NATION ON THE NEXT TICK IF NOT REMEDIED!`
                : `This ${burnOil ? 'burn' : 'action'} will create rebels on the next tick if not remedied!`;
            const summary = [
                el('strong', { class: 'clop-action-satisfaction-title' }, [headline]),
            ];

            if (burnOil) {
                summary.push(el('div', { class: 'clop-action-satisfaction-summary' }, [
                    el('span', {}, ['You selected to burn:']),
                    el('span', {}, [
                        el('strong', {}, [core.commas(burnOil.oilBurned)]),
                        ` oil (burn ${core.commas(burnOil.times)} time${burnOil.times === 1 ? '' : 's'})`,
                    ]),
                    el('span', {}, ['Outcome:']),
                    el('span', {}, [
                        el('strong', {}, [core.commas(satisfactionProjection.satisfactionAfter)]),
                        ' satisfaction',
                    ]),
                    el('span', {}, ['Next tick:']),
                    el('span', {}, [
                        el('strong', {}, [core.commas(satisfactionProjection.nextTickSatisfaction)]),
                        ` satisfaction (projected ${signed(
                            satisfactionProjection.perTickWithoutDecayAfter)}/tick, decay ignored)`,
                    ]),
                ]));
            } else {
                summary.push(el('div', { class: 'clop-action-satisfaction-summary' }, [
                    el('span', {}, ['Outcome:']),
                    el('span', {}, [
                        el('strong', {}, [core.commas(satisfactionProjection.satisfactionAfter)]),
                        ' satisfaction',
                    ]),
                    el('span', {}, ['Next tick:']),
                    el('span', {}, [
                        el('strong', {}, [core.commas(satisfactionProjection.nextTickSatisfaction)]),
                        ` satisfaction (projected ${signed(
                            satisfactionProjection.perTickWithoutDecayAfter)}/tick, decay ignored)`,
                    ]),
                ]));
            }

            if (burnOil) {
                const suggestedTimes = burnOil.times % BURN_OIL_UNITS_PER_ACTION === 0
                    ? burnOil.times / BURN_OIL_UNITS_PER_ACTION
                    : null;
                if (suggestedTimes) {
                    summary.push(el('div', { class: 'clop-burn-oil-risk-suggestion' }, [
                        'Did you mean to burn ', el('strong', {}, [core.commas(suggestedTimes)]),
                        ` time${suggestedTimes === 1 ? '' : 's'} instead?`,
                    ]));
                }
            }

            body.push(el('div', {
                class: `alert alert-danger${collapse ? ' clop-action-collapse-risk' : ''}`,
            }, summary));
        }
        const ordinaryWarnings = actionWarningGroup(core, {
            resourceRateRisks, risks,
            satisfactionTrend: satisfactionTrend ? satisfactionProjection : null,
            burnOilReminder: !!hazard && !!burnOil,
            wartick,
        });
        if (ordinaryWarnings) body.push(ordinaryWarnings);
        body.push(el('p', {}, [burnOil ? 'Burn anyway?' : 'Perform this action anyway?']));
        return actionConfirm({
            title: `Review action: ${quantity}`,
            operation: quantity,
            body,
            affordability,
            warningCount: risks.length + resourceRateRisks.length
                + Number(!!hazard || satisfactionTrend),
            confirmLabel: burnOil ? 'Burn anyway' : 'Perform anyway',
            tickRelevant: !!hazard || risks.length > 0,
            // Satisfaction is due every tick; resource-only military warnings
            // must not claim the payment is due on an intervening normal tick.
            secondsUntilRisk: wartick && !hazard && !satisfactionTrend
                ? () => Math.max(0, Math.ceil((wartick.at - Date.now()) / 1000)) : undefined,
            tickName: wartick && !hazard && !satisfactionTrend ? 'wartick' : 'tick',
        });
    }

    return { actionConfirm, riskConfirmation };
}
