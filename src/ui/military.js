import { actionTimesValue, phpInteger } from '../adapters/actions.js';
import { armySizeFromDocument, equipmentRecipeFromForm, forceTypesFromDocument } from '../adapters/military.js';
import { fetchResourceStats, readCachedResourceStats, RESOURCE_STATS_CACHE_KEY } from '../adapters/overview.js';
import { isLoggedInDoc } from '../adapters/session.js';
import { BUILDING_EFFECTS, BUILDING_UPKEEP } from '../data/actions.generated.js';
import { projectActionAffordability, projectActionResourceRates, projectActionRisks, projectActionSatisfaction } from '../lib/action-safety.js';
import { nextWartick, projectForceCreation } from '../lib/military-safety.js';
import { createActionSafetyDialogs } from './action-warning.js';
import { prepareActionQuantity } from './action-submission.js';
import { executeDynamicRequest } from './dynamic-request.js';
import { createEquipmentOptions } from './equipment-options.js';
import { replacePageContent } from './page-content.js';

const PAGES = new Set(['createforces.php', 'makeequipment.php', 'equipforces.php']);
const FORMS = 'form:has(input[name="token_createforces"]), form:has(input[name="token_makeweapons"]), form:has(input[name="token_makearmor"]), form:has(input[name="token_equipforces"])';

export const militaryModule = {
    name: 'military',
    matches: (page) => PAGES.has(page),
    init(core) {
        const page = location.pathname.split('/').pop();
        const dialogs = createActionSafetyDialogs(core);
        const equipment = page === 'equipforces.php' ? createEquipmentOptions(document) : null;
        const bound = new WeakSet();
        let pending = false;
        let inventoryAfter = Date.now();
        core.addStyle('form.clop-military-pending { opacity: .7; pointer-events: none; }');

        function updateInventory(stats) {
            if (equipment && Number(stats?.at) >= inventoryAfter) equipment.update(stats);
        }
        if (equipment) {
            core.events.on('overview:resourceStats', ({ stats }) => updateInventory(stats));
            window.addEventListener('storage', (event) => {
                if (event.key === RESOURCE_STATS_CACHE_KEY) updateInventory(readCachedResourceStats());
            });
        }

        async function review(form, params) {
            if (page === 'equipforces.php' || !core.settings.get('actions.confirmUpkeepRisk')) return true;
            const times = phpInteger(params.get(page === 'createforces.php' ? 'size' : 'times'));
            // Invalid nonpositive values are left to the server's validation.
            if (times < 1) return true;
            let action, result;
            try {
                if (!Number.isSafeInteger(times)) throw new Error('Quantity is too large to calculate safely.');
                const stats = await fetchResourceStats(core);
                const mode = core.settings.get('actions.satisfactionSafetyMode');
                if (page === 'createforces.php') {
                    const select = form.querySelector('[name="forcetype"]');
                    const option = [...select.options].find((item) => item.value === params.get('forcetype'));
                    if (!option?.value) return true; // Server validates missing type/name.
                    const type = forceTypesFromDocument(document).get(option.textContent.trim());
                    if (!type) throw new Error('Could not read the live force price and upkeep.');
                    const armyDoc = await core.http.getDoc('groupforces.php');
                    if (!isLoggedInDoc(armyDoc)) throw new Error('The game session has expired.');
                    const total = armySizeFromDocument(armyDoc);
                    result = projectForceCreation(type, times, params.get('mercenaries') || '', total, stats, mode);
                    action = { name: `Create ${type.name}` };
                } else {
                    action = equipmentRecipeFromForm(form);
                    if (!Number.isSafeInteger(action.bitsCost * times) || !Number.isSafeInteger(stats.funds)
                        || action.items.some((item) => !Number.isSafeInteger(item.amount * times))) {
                        throw new Error('Could not calculate equipment costs safely.');
                    }
                    result = {
                        affordability: projectActionAffordability(action, times, stats),
                        risks: projectActionRisks(action, times, stats, BUILDING_UPKEEP),
                        resourceRateRisks: projectActionResourceRates(action, times, stats, BUILDING_UPKEEP, BUILDING_EFFECTS),
                        satisfactionProjection: projectActionSatisfaction(action, times, stats, BUILDING_EFFECTS, mode),
                    };
                }
            } catch (error) {
                return dialogs.actionConfirm({
                    title: 'Action safety unavailable', tickRelevant: false,
                    body: [core.el('div', { class: 'alert alert-danger' }, [
                        String(error.message || error), ' Please ',
                        core.el('a', { href: 'viewuser.php?user_id=64' }, ['contact the script author']),
                        ' if this persists.',
                    ]), core.el('p', {}, ['Perform this action without safe-action protection?'])],
                    confirmLabel: 'Perform anyway',
                });
            }
            const showSatisfactionTrend = !!core.settings.get('actions.confirmNegativeSatisfactionRate');
            if (!core.settings.get('actions.confirmNegativeResourceRates')) result.resourceRateRisks = [];
            const { affordability, risks, resourceRateRisks, satisfactionProjection: satisfaction } = result;
            if (!affordability.length && !risks.length && !resourceRateRisks.length
                && !satisfaction?.hazard && !(showSatisfactionTrend && satisfaction?.trendRisk)) return true;
            return dialogs.riskConfirmation(action, times, risks, satisfaction, {
                affordability, resourceRateRisks, showSatisfactionTrend,
                wartick: page === 'createforces.php' ? nextWartick() : null,
            });
        }

        function formKey(form) {
            return ['mode', 'weaponrecipe_id', 'armorrecipe_id', 'force_id']
                .map((name) => form.querySelector(`[name="${name}"]`)?.value || '').join('|')
                + (form.querySelector('[name="weapon_id"]') ? '|weapon' : '|armor');
        }

        async function refresh(response, submittedForm) {
            // Successful creation redirects to Equip Forces. Keep this page at
            // Create Forces and obtain its freshly rotated token via a GET.
            const source = page === 'createforces.php' && !response.querySelector('[name="token_createforces"]')
                ? await core.http.getDoc('createforces.php') : response;
            if (!isLoggedInDoc(source)) throw new Error('The game session has expired.');
            const drafts = new Map();
            for (const form of document.querySelectorAll(FORMS)) {
                const values = new Map();
                for (const input of form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), select')) {
                    if (form === submittedForm && page === 'equipforces.php') continue;
                    values.set(input.name, input.value);
                }
                drafts.set(formKey(form), values);
            }
            const scroll = { left: window.scrollX, top: window.scrollY };
            const result = replacePageContent(document, source, undefined, { omitFeedback: true });
            if (!result.available) throw new Error('Could not find the army page content.');
            inventoryAfter = Date.now();
            equipment?.reset(); // Capture server-selected equipment before restoring drafts.
            for (const form of document.querySelectorAll(FORMS)) {
                prepareActionQuantity(form);
                for (const [name, value] of drafts.get(formKey(form)) || []) {
                    const input = form.querySelector(`[name="${name}"]`);
                    if (input) input.value = value;
                }
            }
            bind();
            window.scrollTo(scroll);
            await fetchResourceStats(core);
        }

        function bind() {
            equipment?.bind();
            for (const form of document.querySelectorAll(FORMS)) {
                if (bound.has(form)) continue;
                bound.add(form);
                prepareActionQuantity(form);
                let clicked = null;
                form.addEventListener('click', (event) => {
                    const button = event.target.closest('input[type="submit"], button[type="submit"]');
                    if (button?.form === form) clicked = button;
                });
                form.addEventListener('submit', async (event) => {
                    event.preventDefault();
                    const submitter = event.submitter || clicked || form.querySelector('input[type="submit"]');
                    clicked = null;
                    if (page === 'equipforces.php' && [...form.querySelectorAll('select')]
                        .some((select) => [...select.options].some((option) => option.selected && option.disabled))) return;
                    if (pending) return;
                    pending = true;
                    const label = submitter?.value;
                    // Snapshot exactly what is reviewed; no late edits or
                    // asynchronous inventory updates can change the POST.
                    const params = new FormData(form);
                    if (submitter?.name) params.set(submitter.name, label);
                    const times = actionTimesValue(form);
                    if (times !== undefined) params.set('times', times);
                    for (const name of ['weapon_id', 'armor_id']) {
                        const select = form.querySelector(`select[name="${name}"]`);
                        if (select) params.set(name, select.value);
                    }
                    form.classList.add('clop-military-pending');
                    try {
                        if (submitter) submitter.value = 'Checking…';
                        if (!await review(form, params)) return;
                        if (submitter) submitter.value = 'Performing…';
                        await executeDynamicRequest(core, {
                            send: () => core.http.postForm(page, params),
                            refresh: (response) => refresh(response, form),
                            successTitle: page === 'equipforces.php' ? 'Equipment updated' : 'Action complete',
                            fallbackMessage: page === 'createforces.php' ? 'The force creation was processed.' : 'The action was processed.',
                        });
                    } finally {
                        pending = false;
                        if (submitter) submitter.value = label;
                        form.classList.remove('clop-military-pending');
                    }
                });
            }
        }

        bind();
        if (equipment) {
            // Refresh once on entry, then reuse normal live-update snapshots.
            // A failed optional inventory fetch leaves the server's options.
            fetchResourceStats(core).catch((error) => console.warn('[4clopX] Equipment inventory refresh failed:', error));
        }
    },
};
