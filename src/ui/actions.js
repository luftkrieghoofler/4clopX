import {
    actionsFromDocument, actionFormsFromDocument, phpInteger, submittedAction,
} from '../adapters/actions.js';
import {
    formatTickDuration, tickIsCritical, tickIsImminent, tickSecondsFromDocument,
} from '../adapters/header.js';
import { fetchResourceStats } from '../adapters/overview.js';
import { ACTION_CATALOG, BUILDING_EFFECTS, BUILDING_UPKEEP } from '../data/actions.generated.js';
import {
    actionCompatibility, actionNeedsSafetyCheck, projectActionResourceRates,
    projectActionRisks, projectActionSatisfaction,
} from '../lib/action-safety.js';
import { upkeepRiskListItem } from './upkeep-warning.js';

const SETTING_KEY = 'actions.confirmUpkeepRisk';
const SATISFACTION_TREND_SETTING_KEY = 'actions.confirmNegativeSatisfactionRate';
const RESOURCE_TREND_SETTING_KEY = 'actions.confirmNegativeResourceRates';
const AUTHOR_URL = 'viewuser.php?user_id=64';
const IMMINENT_TICK_SECONDS = 10 * 60;
const CRITICAL_TICK_SECONDS = 90;
const BURN_OIL_ACTION_ID = '4';
const BURN_OIL_UNITS_PER_ACTION = 5;
const BURN_OIL_SAT_PER_ACTION = 5;

export function burnOilOutcome(times, satisfaction) {
    if (!Number.isSafeInteger(times) || times < 1 || !Number.isFinite(satisfaction)) return null;
    const oilBurned = times * BURN_OIL_UNITS_PER_ACTION;
    const satisfactionLost = times * BURN_OIL_SAT_PER_ACTION;
    const satisfactionAfter = satisfaction - satisfactionLost;
    if (![oilBurned, satisfactionLost, satisfactionAfter].every(Number.isSafeInteger)) return null;
    return {
        times,
        oilBurned,
        satisfactionBefore: satisfaction,
        satisfactionLost,
        satisfactionAfter,
    };
}

export const actionsModule = {
    name: 'actions',

    matches(page) {
        return page === 'actions.php' || page === 'favoriteactions.php' || page === 'overview.php';
    },

    settings(core) {
        core.settings.define({
            key: SETTING_KEY,
            label: 'Confirm risky actions',
            description: 'Before performing a known Action or Favorite Action, check protected upkeep, satisfaction, and production risks.',
            type: 'bool',
            default: true,
            section: 'Actions',
        });
        core.settings.define({
            key: SATISFACTION_TREND_SETTING_KEY,
            label: 'Warn when satisfaction/tick is negative',
            description: 'Confirm actions that create or worsen an ongoing satisfaction decline.',
            type: 'bool',
            default: true,
            parent: SETTING_KEY,
            section: 'Actions',
        });
        core.settings.define({
            key: RESOURCE_TREND_SETTING_KEY,
            label: 'Warn when domestic resource/tick is negative',
            description: 'Confirm actions that create or worsen a deficit in a domestically produced resource.',
            type: 'bool',
            default: true,
            parent: SETTING_KEY,
            section: 'Actions',
        });
    },

    init(core) {
        const page = location.pathname.replace(/^.*\//, '');
        const el = core.el.bind(core);
        const forms = actionFormsFromDocument(document);
        const states = new Map();
        let loadError = null;

        core.addStyle(`
            #clop-action-compat-summary { max-width: 820px; margin: 0 auto 12px; text-align: left; }
            .clop-action-compat-warning { margin: 8px 0; padding: 7px 9px; text-align: left; font-size: 90%; }
            .clop-action-compat-warning a, #clop-action-compat-summary a { font-weight: bold; }
            .clop-action-tick-critical { border-width: 2px; font-size: 105%; }
            .clop-burn-oil-warning { clear: both; display: none; margin: 6px 0 4px; padding: 6px 8px; text-align: left; font-size: 90%; line-height: 1.4; }
            .clop-burn-oil-warning.clop-active { display: block; }
            .clop-action-satisfaction-title { display: block; margin-bottom: 8px; }
            .clop-action-satisfaction-summary { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; }
            .clop-action-satisfaction-summary strong { font-size: 110%; }
            .clop-action-collapse-risk { border-width: 2px; }
            .clop-burn-oil-risk-suggestion { margin-top: 8px; }
            form.clop-action-checking { opacity: .7; pointer-events: none; }
        `);

        const actualActionsPromise = page === 'actions.php'
            ? Promise.resolve(actionsFromDocument(document))
            : core.http.getDoc('actions.php').then(actionsFromDocument).catch((error) => {
                loadError = error;
                return null;
            });

        function stateFor(id, actualActions) {
            if (states.has(id)) return states.get(id);
            const expected = ACTION_CATALOG[id] || null;
            const actual = actualActions && actualActions.get(id) || null;
            let compatibility;
            if (!expected) compatibility = { status: 'unknown', differences: ['No catalogue data exists'] };
            else if (!actual) compatibility = { status: 'unavailable', differences: ['Live description unavailable'] };
            else compatibility = actionCompatibility(actual, expected);
            const state = { id, expected, actual, ...compatibility };
            states.set(id, state);
            return state;
        }

        function authorLink() {
            return el('a', { href: AUTHOR_URL }, ['contact the script author']);
        }

        function warningText(state) {
            if (state.status === 'unknown') {
                return [
                    el('strong', {}, ['4clopX has no safety data for this action.']),
                    ' It will not calculate this action’s resource or upkeep effects. Please ',
                    authorLink(), ' and ask for the action to be added.',
                ];
            }
            return [
                el('strong', {}, ['This action changed from the version understood by 4clopX.']),
                ` Its ${state.differences.join(' and ')} no longer matches the old mechanics, so `,
                'safe-action calculations are disabled for it. Please ', authorLink(),
                ' and ask for the script data to be updated.',
            ];
        }

        function annotateForm(record, state) {
            if (state.status !== 'unknown' && state.status !== 'changed') return;
            const isFavourite = record.form.querySelector('input[name="token_favoriteactions"]');
            const host = isFavourite
                ? record.form.closest('.panel')
                : record.form.closest('td');
            if (!host || host.querySelector(`.clop-action-compat-warning[data-action-id="${record.id}"]`)) return;
            const warning = el('div', {
                class: 'alert alert-danger clop-action-compat-warning',
                'data-action-id': record.id,
            }, warningText(state));
            if (isFavourite) {
                const table = host.querySelector('table');
                host.insertBefore(warning, table || null);
            } else {
                host.insertBefore(warning, record.form);
            }
        }

        function annotateBurnOil(record, state) {
            if (record.id !== BURN_OIL_ACTION_ID || state.status !== 'verified') return;
            const input = record.form.querySelector('input[name="times"][type="text"]');
            if (!input || record.form.querySelector('.clop-burn-oil-warning')) return;

            const totalLine = el('div');
            const warning = el('div', {
                class: 'alert alert-warning clop-burn-oil-warning',
                'aria-hidden': 'true',
            }, [
                el('div', {}, [
                    '⚠ Remember ', el('strong', {}, ['1 action']), ' burns ',
                    el('strong', {}, ['5 oil']), '!',
                ]),
                totalLine,
            ]);

            function update() {
                const times = phpInteger(input.value);
                const total = times * BURN_OIL_UNITS_PER_ACTION;
                if (!Number.isSafeInteger(times) || times < 1 || !Number.isSafeInteger(total)) {
                    totalLine.textContent = 'Enter a whole-number action quantity to see the total.';
                    return;
                }
                const amount = core.commas(total);
                totalLine.replaceChildren(
                    el('strong', {}, [core.commas(times)]),
                    ` action${times === 1 ? '' : 's'} will burn `,
                    el('strong', {}, [amount]),
                    ' oil and lose ',
                    el('strong', {}, [amount]),
                    ' satisfaction.',
                );
            }

            const row = input.closest('.form-inline');
            if (row) row.insertAdjacentElement('afterend', warning);
            else input.insertAdjacentElement('afterend', warning);
            const initialValue = input.value;
            let focused = false;
            let editedFromDefault = false;

            function setVisible(visible) {
                warning.classList.toggle('clop-active', visible);
                warning.setAttribute('aria-hidden', visible ? 'false' : 'true');
            }

            input.addEventListener('input', () => {
                update();
                if (focused && input.value !== initialValue) editedFromDefault = true;
                setVisible(focused || editedFromDefault);
            });
            input.addEventListener('focus', () => {
                focused = true;
                update();
                setVisible(true);
            });
            input.addEventListener('blur', () => {
                focused = false;
                setVisible(editedFromDefault);
            });
            update();
        }

        function renderSummary() {
            document.querySelector('#clop-action-compat-summary')?.remove();
            const affected = [...states.values()].filter((state) =>
                state.status === 'unknown' || state.status === 'changed');
            if (!affected.length) return;
            const names = affected.map((state) =>
                (state.actual && state.actual.name) || (state.expected && state.expected.name) || `Action #${state.id}`);
            const summary = el('div', {
                id: 'clop-action-compat-summary',
                class: 'alert alert-danger',
            }, [
                el('strong', {}, [`4clopX cannot safely interpret ${affected.length} action${affected.length === 1 ? '' : 's'}.`]),
                ` Calculated protection is disabled for: ${names.join(', ')}. `,
                'The actions remain usable, but their live text does not have matching mechanics in the script. Please ',
                authorLink(), ' so the catalogue can be updated.',
            ]);
            const container = document.querySelector('#container');
            if (container && container.parentNode) container.parentNode.insertBefore(summary, container);
        }

        function setChecking(form, submitter, checking) {
            form.classList.toggle('clop-action-checking', checking);
            if (!submitter) return;
            if (checking) {
                submitter.dataset.clopOldLabel = submitter.value || submitter.textContent;
                if ('value' in submitter) submitter.value = 'Checking safety…';
                else submitter.textContent = 'Checking safety…';
            } else {
                const old = submitter.dataset.clopOldLabel;
                if (old !== undefined) {
                    if ('value' in submitter) submitter.value = old;
                    else submitter.textContent = old;
                    delete submitter.dataset.clopOldLabel;
                }
            }
        }

        function submitNatively(form) {
            HTMLFormElement.prototype.submit.call(form);
        }

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
                el('strong', {}, ['TICK IS ABOUT TO HAPPEN']),
                el('div', {}, [
                    'Do not proceed unless you can remedy the highlighted risk within ', criticalSeconds, '.',
                ]),
            ]);
            const bodyChildren = Array.isArray(options.body) ? options.body : [options.body];
            const body = el('div', {}, bodyChildren.length
                ? [bodyChildren[0], imminent, critical, ...bodyChildren.slice(1)]
                : [imminent, critical]);

            function updateTickWarnings() {
                const untilTick = tickSecondsFromDocument(document);
                const tickRelevant = options.tickRelevant !== false;
                const showCritical = tickRelevant && tickIsCritical(untilTick, CRITICAL_TICK_SECONDS);
                const showImminent = tickRelevant && !showCritical
                    && tickIsImminent(untilTick, IMMINENT_TICK_SECONDS);
                imminent.style.display = showImminent ? '' : 'none';
                critical.style.display = showCritical ? '' : 'none';
                if (showImminent) {
                    imminentHeadline.textContent = `Next tick in ${formatTickDuration(untilTick)}.`;
                }
                if (showCritical) {
                    criticalSeconds.textContent =
                        `${untilTick} second${untilTick === 1 ? '' : 's'}`;
                }
            }

            return core.confirm({
                ...options,
                body,
                onOpen: () => {
                    updateTickWarnings();
                    const timer = setInterval(updateTickWarnings, 250);
                    return () => clearInterval(timer);
                },
            });
        }

        function unprotectedConfirmation(state) {
            const name = (state.actual && state.actual.name)
                || (state.expected && state.expected.name) || `Action #${state.id}`;
            if (state.status === 'changed') {
                return actionConfirm({
                    title: 'Action mechanics changed',
                    body: [
                        el('div', { class: 'alert alert-danger' }, [
                            el('strong', {}, [`${name} cannot be checked safely. `]),
                            'Its live description differs from the version understood by 4clopX.',
                        ]),
                        el('p', {}, ['Perform it without safe-action protection?']),
                    ],
                    confirmLabel: 'Perform anyway',
                });
            }
            if (state.status === 'unknown') {
                return actionConfirm({
                    title: 'Unknown action mechanics',
                    body: [
                        el('div', { class: 'alert alert-danger' }, [
                            el('strong', {}, [`${name} cannot be checked safely. `]),
                            '4clopX has no mechanics data for this action.',
                        ]),
                        el('p', {}, ['Perform it without safe-action protection?']),
                    ],
                    confirmLabel: 'Perform anyway',
                });
            }
            return true;
        }

        function signed(value) {
            return value > 0 ? `+${core.commas(value)}` : core.commas(value);
        }

        function riskConfirmation(action, times, risks, satisfactionProjection, {
            burnOil = null,
            showSatisfactionTrend = true,
            resourceRateRisks = [],
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
                            ` satisfaction (currently ${signed(satisfactionProjection.perTickAfter)}/tick)`,
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
                            ` satisfaction (projected ${signed(satisfactionProjection.perTickAfter)}/tick)`,
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
                if (burnOil) {
                    body.push(el('div', { class: 'alert alert-warning' }, [
                        '⚠ Remember: ', el('strong', {}, ['1 action burns 5 oil.']),
                        ' Divide the oil you intend to burn by 5 before entering the action count.',
                    ]));
                }
            } else if (satisfactionTrend) {
                const heading = satisfactionProjection.perTickBefore >= 0
                    ? 'This action would make satisfaction decrease each tick.'
                    : 'This action would make the existing satisfaction decline worse.';
                body.push(el('div', { class: 'alert alert-warning' }, [
                    el('strong', { class: 'clop-action-satisfaction-title' }, [heading]),
                    el('div', { class: 'clop-action-satisfaction-summary' }, [
                        el('span', {}, ['Satisfaction/tick:']),
                        el('span', {}, [
                            el('strong', {}, [signed(satisfactionProjection.perTickBefore)]),
                            ' → ', el('strong', {}, [signed(satisfactionProjection.perTickAfter)]),
                        ]),
                    ]),
                ]));
            }
            if (resourceRateRisks.length) {
                const rateRows = [];
                for (const risk of resourceRateRisks) {
                    rateRows.push(
                        el('span', {}, [`${risk.name}/tick:`]),
                        el('span', {}, [
                            el('strong', {}, [signed(risk.netBefore)]),
                            ' → ', el('strong', {}, [signed(risk.netAfter)]),
                        ]),
                    );
                }
                body.push(el('div', { class: 'alert alert-warning' }, [
                    el('strong', { class: 'clop-action-satisfaction-title' }, [
                        'This action would create or worsen domestic resource deficits.',
                    ]),
                    el('div', { class: 'clop-action-satisfaction-summary' }, rateRows),
                ]));
            }
            if (risks.length) {
                body.push(
                    el('div', { class: 'alert alert-warning' }, [
                        el('strong', {}, [`${quantity} would leave insufficient stock `]),
                        'for the protected upkeep reserve (tick consumption and military upkeep).',
                    ]),
                    el('ul', { class: 'clop-confirm-risk-list' },
                        risks.map((risk) => upkeepRiskListItem(core, risk))),
                );
            }
            let title = 'Upkeep reserve at risk';
            if (hazard === 'collapse') title = 'Nation collapse risk';
            else if (hazard === 'rebels') title = 'Rebel risk';
            else {
                const warningTypes = Number(satisfactionTrend)
                    + Number(resourceRateRisks.length > 0) + Number(risks.length > 0);
                if (warningTypes > 1) title = 'Action safety warning';
                else if (satisfactionTrend) title = 'Satisfaction declining';
                else if (resourceRateRisks.length) title = 'Resource production declining';
            }
            return actionConfirm({
                title,
                body,
                confirmLabel: burnOil ? 'Burn anyway' : 'Perform anyway',
                tickRelevant: !!hazard || risks.length > 0,
            });
        }

        for (const record of forms) {
            let clickedSubmitter = null;
            record.form.addEventListener('click', (event) => {
                const submitter = event.target.closest('input[type="submit"], button[type="submit"]');
                if (submitter && submitter.form === record.form) clickedSubmitter = submitter;
            });
            record.form.addEventListener('submit', async (event) => {
                const submitter = event.submitter || clickedSubmitter;
                clickedSubmitter = null;
                const submission = submittedAction(record.form, submitter);
                if (!submission || !core.settings.get(SETTING_KEY)) return;
                event.preventDefault();
                if (record.form.classList.contains('clop-action-checking')) return;
                setChecking(record.form, submitter, true);

                try {
                    const actualActions = await actualActionsPromise;
                    const state = stateFor(record.id, actualActions);
                    if (state.status === 'changed' || state.status === 'unknown') {
                        if (await unprotectedConfirmation(state)) submitNatively(record.form);
                        return;
                    }
                    if (state.status !== 'verified') {
                        const detail = loadError ? ` (${String(loadError.message || loadError)})` : '';
                        if (await actionConfirm({
                            title: 'Action safety unavailable',
                            body: [
                                el('div', { class: 'alert alert-danger' }, [
                                    `4clopX could not load the live description for this action${detail}.`,
                                ]),
                                el('p', {}, ['Perform it without safe-action protection?']),
                            ],
                            confirmLabel: 'Perform anyway',
                        })) submitNatively(record.form);
                        return;
                    }
                    if (submission.times < 1) {
                        submitNatively(record.form); // Let the server show its normal validation error.
                        return;
                    }
                    if (!Number.isSafeInteger(submission.times)) {
                        if (await actionConfirm({
                            title: 'Action quantity cannot be checked',
                            body: [
                                el('div', { class: 'alert alert-danger' }, [
                                    'The action quantity is too large for 4clopX to calculate safely.',
                                ]),
                                el('p', {}, ['Perform it without safe-action protection?']),
                            ],
                            confirmLabel: 'Perform anyway',
                        })) submitNatively(record.form);
                        return;
                    }
                    if (!actionNeedsSafetyCheck(state.expected, BUILDING_UPKEEP, BUILDING_EFFECTS)) {
                        submitNatively(record.form);
                        return;
                    }

                    let stats;
                    try {
                        stats = await fetchResourceStats(core);
                    } catch (error) {
                        if (await actionConfirm({
                            title: 'Current stock could not be checked',
                            body: [
                                el('div', { class: 'alert alert-danger' }, [
                                    `4clopX could not load your current stock and upkeep ` +
                                    `(${String(error.message || error)}).`,
                                ]),
                                el('p', {}, ['Perform this action without safe-action protection?']),
                            ],
                            confirmLabel: 'Perform anyway',
                        })) submitNatively(record.form);
                        return;
                    }
                    const risks = projectActionRisks(
                        state.expected, submission.times, stats, BUILDING_UPKEEP);
                    const satisfactionProjection = projectActionSatisfaction(
                        state.expected, submission.times, stats, BUILDING_EFFECTS);
                    const showSatisfactionTrend = !!core.settings.get(
                        SATISFACTION_TREND_SETTING_KEY);
                    const resourceRateRisks = core.settings.get(RESOURCE_TREND_SETTING_KEY)
                        ? projectActionResourceRates(
                            state.expected, submission.times, stats,
                            BUILDING_UPKEEP, BUILDING_EFFECTS)
                        : [];
                    const burnOil = record.id === BURN_OIL_ACTION_ID
                        ? burnOilOutcome(submission.times, stats.satisfaction)
                        : null;
                    const satisfactionRisk = satisfactionProjection
                        && (satisfactionProjection.hazard
                            || (showSatisfactionTrend && satisfactionProjection.trendRisk));
                    if ((!risks.length && !satisfactionRisk && !resourceRateRisks.length)
                        || await riskConfirmation(
                            state.expected, submission.times, risks, satisfactionProjection, {
                                burnOil, showSatisfactionTrend, resourceRateRisks,
                            })) {
                        submitNatively(record.form);
                    }
                } finally {
                    setChecking(record.form, submitter, false);
                }
            });
        }

        actualActionsPromise.then((actualActions) => {
            if (!actualActions) return;
            for (const record of forms) {
                const state = stateFor(record.id, actualActions);
                annotateForm(record, state);
                annotateBurnOil(record, state);
            }
            renderSummary();
        });
    },
};
