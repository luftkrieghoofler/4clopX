import {
    actionsFromDocument, actionFormsFromDocument, phpInteger, submittedAction,
} from '../adapters/actions.js';
import {
    formatTickDuration, tickIsCritical, tickIsImminent, tickSecondsFromDocument,
} from '../adapters/header.js';
import { fetchResourceStats } from '../adapters/overview.js';
import { ACTION_CATALOG, BUILDING_EFFECTS, BUILDING_UPKEEP } from '../data/actions.generated.js';
import {
    actionCompatibility, actionNeedsSafetyCheck, projectActionAffordability, projectActionResourceRates,
    projectActionRisks, projectActionSatisfaction, SATISFACTION_SAFETY_MODES,
} from '../lib/action-safety.js';
import { protectedReserve, reserveSafeMax } from '../lib/upkeep-safety.js';
import { upkeepWarningSection } from './upkeep-warning.js';
import { rateRiskListItem, warningGroup, warningSection } from './warning-content.js';
import { affordabilityDialogOptions } from './affordability-warning.js';
import { executeDynamicAction, isDynamicActionSubmission, replaceActionContent } from './action-submission.js';
import { initialiseMasonry } from './page-content.js';

const SETTING_KEY = 'actions.confirmUpkeepRisk';
const SATISFACTION_TREND_SETTING_KEY = 'actions.confirmNegativeSatisfactionRate';
export const SATISFACTION_SAFETY_MODE_SETTING_KEY = 'actions.satisfactionSafetyMode';
const RESOURCE_TREND_SETTING_KEY = 'actions.confirmNegativeResourceRates';
const AUTHOR_URL = 'viewuser.php?user_id=64';
const IMMINENT_TICK_SECONDS = 10 * 60;
const CRITICAL_TICK_SECONDS = 90;
const BURN_OIL_ACTION_ID = '4';
const BURN_OIL_UNITS_PER_ACTION = 5;
const BURN_OIL_SAT_PER_ACTION = 5;
const MAX_DISTRIBUTION_ACTION_IDS = new Set(['8', '9']);

export function actionWarningGroup(core, {
    resourceRateRisks = [], risks = [], satisfactionTrend = null, burnOilReminder = false,
}) {
    const sections = [];
    if (resourceRateRisks.length) {
        sections.push(warningSection(core, 'Domestic production deficit',
            resourceRateRisks.map((risk) => rateRiskListItem(
                core, risk.name, risk.netBefore, risk.netAfter))));
    }
    sections.push(upkeepWarningSection(core, risks));
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
            description: 'Before performing a known Action or Favorite Action, check affordability, protected upkeep, satisfaction, and production risks.',
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
            key: SATISFACTION_SAFETY_MODE_SETTING_KEY,
            label: 'Satisfaction safety strategy',
            description: 'Stable balance ignores the temporary decay from already-high satisfaction. Maximise GDP evaluates builds with the full −30/tick decay at your government’s satisfaction cap. Rebel-risk projections always ignore decay.',
            type: 'choice',
            options: [
                { value: SATISFACTION_SAFETY_MODES.STABLE, label: 'Stable balance' },
                { value: SATISFACTION_SAFETY_MODES.MAXIMUM, label: 'Maximise GDP' },
            ],
            default: SATISFACTION_SAFETY_MODES.STABLE,
            parent: SATISFACTION_TREND_SETTING_KEY,
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
        const states = new Map();
        const boundForms = new WeakSet();
        let loadError = null;
        let actionPending = false;

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
            .clop-action-max-input { border-top-right-radius: 0; border-bottom-right-radius: 0; }
            .clop-action-max-button { margin-left: -1px; border-top-left-radius: 0; border-bottom-left-radius: 0; vertical-align: top; }
            form.clop-action-checking { opacity: .7; pointer-events: none; }
        `);

        let actualActionsPromise = page === 'actions.php'
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

        function annotateDistributionMax(record, state) {
            if (!MAX_DISTRIBUTION_ACTION_IDS.has(record.id) || state.status !== 'verified') return;
            const input = record.form.querySelector('input[name="times"][type="text"]');
            if (!input || record.form.querySelector('.clop-action-max-button')) return;
            const item = state.expected.items.find((candidate) =>
                candidate.consumed && !candidate.isBuilding);
            if (!item) return;

            input.classList.add('clop-action-max-input');
            const button = el('button', {
                class: 'btn btn-default clop-action-max-button',
                type: 'button',
                title: `Use the ${item.name} spare above tick consumption and military upkeep`,
            }, [el('strong', {}, ['Max'])]);
            input.insertAdjacentElement('afterend', button);

            button.addEventListener('click', async () => {
                if (button.disabled) return;
                button.disabled = true;
                button.textContent = '…';
                try {
                    const stats = await fetchResourceStats(core);
                    // Resources with no stock, production, or upkeep may be
                    // omitted from the Overview table; that is a known zero,
                    // rather than a failed Max calculation.
                    const resource = stats.byName[item.name.toLowerCase()]
                        || { qty: 0, used: 0, mil: 0 };
                    const reserve = protectedReserve(resource);
                    const max = reserveSafeMax(resource.qty, reserve, item.amount);
                    if (max === null) throw new Error(`${item.name} stock or upkeep could not be read`);

                    input.value = String(max);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    button.title = max > 0
                        ? `Set ${core.commas(max)} action${max === 1 ? '' : 's'}, consuming ` +
                            `${core.commas(max * item.amount)} ${item.name} and keeping ` +
                            `${core.commas(reserve)} reserved`
                        : `No ${item.name} are spare above the ${core.commas(reserve)} reserve`;
                } catch (error) {
                    console.warn(`[4clopX] ${state.expected.name} Max failed:`, error);
                    button.title = `Could not calculate Max: ${String(error.message || error)}. Click to retry.`;
                } finally {
                    button.disabled = false;
                    button.replaceChildren(el('strong', {}, ['Max']));
                }
            });
        }

        function renderSummary(forms) {
            document.querySelector('#clop-action-compat-summary')?.remove();
            const visibleIds = new Set(forms.map((record) => record.id));
            const affected = [...states.values()].filter((state) =>
                visibleIds.has(state.id)
                && (state.status === 'unknown' || state.status === 'changed'));
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

        async function submitForm(form, submitter) {
            if (!isDynamicActionSubmission(page, form, submitter)) {
                HTMLFormElement.prototype.submit.call(form);
                return;
            }
            await executeDynamicAction(core, { page, form, submitter, refresh: async (response) => {
                if (page === 'overview.php') {
                    await core.overview.refresh();
                    return;
                }
                const scroll = { left: window.scrollX, top: window.scrollY };
                replaceActionContent(document, response);
                if (page === 'actions.php') {
                    // Recheck compatibility against the new, unannotated page.
                    states.clear();
                    actualActionsPromise = Promise.resolve(actionsFromDocument(response));
                }
                bindForms();
                setTimeout(() => {
                    initialiseMasonry(document);
                    window.scrollTo(scroll);
                }, 0);
                // Update shared stock/buffer badges after spending resources,
                // just as refreshing Overview does after its inline actions.
                await fetchResourceStats(core);
            } });
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
            const body = el('div', {}, [imminent, critical, ...bodyChildren]);

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
            affordability = [],
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
            });
        }

        function bindForms() {
            const forms = actionFormsFromDocument(document);
            for (const record of forms) {
                if (boundForms.has(record.form)) continue;
                boundForms.add(record.form);
                let clickedSubmitter = null;
                record.form.addEventListener('click', (event) => {
                    const submitter = event.target.closest('input[type="submit"], button[type="submit"]');
                    if (submitter && submitter.form === record.form) clickedSubmitter = submitter;
                });
                record.form.addEventListener('submit', async (event) => {
                    const submitter = event.submitter || clickedSubmitter;
                    clickedSubmitter = null;
                    const submission = submittedAction(record.form, submitter);
                    const dynamic = isDynamicActionSubmission(page, record.form, submitter);
                    if (!submission || !core.settings.get(SETTING_KEY)) {
                        if (!dynamic) return;
                        event.preventDefault();
                        if (actionPending) return;
                        actionPending = true;
                        setChecking(record.form, submitter, true);
                        try {
                            await submitForm(record.form, submitter);
                        } finally {
                            actionPending = false;
                            setChecking(record.form, submitter, false);
                        }
                        return;
                    }
                    event.preventDefault();
                    // All recipe forms share a rotating token. Do not queue a
                    // second action while the first is checking or refreshing.
                    if (actionPending) return;
                    actionPending = true;
                    setChecking(record.form, submitter, true);

                    try {
                        const actualActions = await actualActionsPromise;
                        const state = stateFor(record.id, actualActions);
                        if (state.status === 'changed' || state.status === 'unknown') {
                            if (await unprotectedConfirmation(state)) {
                                await submitForm(record.form, submitter);
                            }
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
                            })) await submitForm(record.form, submitter);
                            return;
                        }
                        if (submission.times < 1) {
                            // Let the server show its normal validation error.
                            await submitForm(record.form, submitter);
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
                            })) await submitForm(record.form, submitter);
                            return;
                        }
                        const action = { ...state.expected, bitsCost: state.actual.bitsCost };
                        if (!actionNeedsSafetyCheck(action, BUILDING_UPKEEP, BUILDING_EFFECTS)) {
                            await submitForm(record.form, submitter);
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
                            })) await submitForm(record.form, submitter);
                            return;
                        }
                        const affordability = projectActionAffordability(
                            action, submission.times, stats);
                        const risks = projectActionRisks(
                            state.expected, submission.times, stats, BUILDING_UPKEEP);
                        const satisfactionProjection = projectActionSatisfaction(
                            state.expected, submission.times, stats, BUILDING_EFFECTS,
                            core.settings.get(SATISFACTION_SAFETY_MODE_SETTING_KEY));
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
                        if ((!affordability.length && !risks.length && !satisfactionRisk && !resourceRateRisks.length)
                            || await riskConfirmation(
                                state.expected, submission.times, risks, satisfactionProjection, {
                                    burnOil, showSatisfactionTrend, resourceRateRisks, affordability,
                                })) {
                            await submitForm(record.form, submitter);
                        }
                    } finally {
                        actionPending = false;
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
                    annotateDistributionMax(record, state);
                }
                renderSummary(forms);
            });
        }

        bindForms();
        core.events.on('overview:contentReplaced', bindForms);
    },
};
