import { actionsFromDocument, actionFormsFromDocument, submittedAction } from '../adapters/actions.js';
import { fetchResourceStats } from '../adapters/overview.js';
import { ACTION_CATALOG, BUILDING_UPKEEP } from '../data/actions.generated.js';
import {
    actionCompatibility, actionNeedsSafetyCheck, projectActionRisks,
} from '../lib/action-safety.js';

const SETTING_KEY = 'actions.confirmUpkeepRisk';
const AUTHOR_URL = 'viewuser.php?user_id=64';

export const actionsModule = {
    name: 'actions',

    matches(page) {
        return page === 'actions.php' || page === 'favoriteactions.php' || page === 'overview.php';
    },

    settings(core) {
        core.settings.define({
            key: SETTING_KEY,
            label: 'Confirm actions that endanger upkeep',
            description: 'Before performing a known Action or Favorite Action, check whether its immediate costs or resulting upkeep would leave a resource below its protected reserve.',
            type: 'bool',
            default: true,
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

        function unprotectedConfirmation(state) {
            const name = (state.actual && state.actual.name)
                || (state.expected && state.expected.name) || `Action #${state.id}`;
            if (state.status === 'changed') {
                return window.confirm(
                    `${name} has changed from the version understood by 4clopX. ` +
                    'Its effects cannot be checked safely.\n\nPerform it without safe-action protection?');
            }
            if (state.status === 'unknown') {
                return window.confirm(
                    `4clopX has no data for ${name}, so its effects cannot be checked safely.\n\n` +
                    'Perform it without safe-action protection?');
            }
            return true;
        }

        function riskConfirmation(action, times, risks) {
            const quantity = times === 1 ? action.name : `${action.name} × ${core.commas(times)}`;
            const lines = risks.map((risk) => {
                const stock = `stock ${core.commas(risk.stockBefore)} → ${core.commas(risk.stockAfter)}`;
                const reserve = risk.reserveBefore === risk.reserveAfter
                    ? `reserve ${core.commas(risk.reserveAfter)}`
                    : `reserve ${core.commas(risk.reserveBefore)} → ${core.commas(risk.reserveAfter)}`;
                return `• ${risk.name}: ${stock}; ${reserve}; short by ${core.commas(risk.shortage)}`;
            });
            return window.confirm(
                `${quantity} would leave insufficient stock for the protected upkeep reserve:\n\n` +
                `${lines.join('\n')}\n\nPerform this action anyway?`);
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
                        if (unprotectedConfirmation(state)) submitNatively(record.form);
                        return;
                    }
                    if (state.status !== 'verified') {
                        const detail = loadError ? ` (${String(loadError.message || loadError)})` : '';
                        if (window.confirm(
                            `4clopX could not load the live description for this action${detail}.\n\n` +
                            'Perform it without safe-action protection?')) submitNatively(record.form);
                        return;
                    }
                    if (submission.times < 1) {
                        submitNatively(record.form); // Let the server show its normal validation error.
                        return;
                    }
                    if (!Number.isSafeInteger(submission.times)) {
                        if (window.confirm(
                            'The action quantity is too large for 4clopX to check safely.\n\n' +
                            'Perform it without safe-action protection?')) submitNatively(record.form);
                        return;
                    }
                    if (!actionNeedsSafetyCheck(state.expected, BUILDING_UPKEEP)) {
                        submitNatively(record.form);
                        return;
                    }

                    let stats;
                    try {
                        stats = await fetchResourceStats(core);
                    } catch (error) {
                        if (window.confirm(
                            `4clopX could not load your current stock and upkeep (${String(error.message || error)}).\n\n` +
                            'Perform this action without safe-action protection?')) submitNatively(record.form);
                        return;
                    }
                    const risks = projectActionRisks(
                        state.expected, submission.times, stats, BUILDING_UPKEEP);
                    if (!risks.length || riskConfirmation(state.expected, submission.times, risks)) {
                        submitNatively(record.form);
                    }
                } finally {
                    setChecking(record.form, submitter, false);
                }
            });
        }

        actualActionsPromise.then((actualActions) => {
            if (!actualActions) return;
            for (const record of forms) annotateForm(record, stateFor(record.id, actualActions));
            renderSummary();
        });
    },
};
