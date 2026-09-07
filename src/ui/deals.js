import { incomingDealsFromDocument, outgoingDealFromForm } from '../adapters/deals.js';
import { fetchResourceStats } from '../adapters/overview.js';
import { projectDealAffordability, projectDealRisks } from '../lib/deal-safety.js';
import { upkeepWarningSection } from './upkeep-warning.js';
import { warningGroup } from './warning-content.js';
import { affordabilityDialogOptions } from './affordability-warning.js';

const SETTING_KEY = 'deals.confirmBelowUpkeep';

export const dealsModule = {
    name: 'deals',

    matches(page) {
        return page === 'deals.php' || page === 'makedeal.php';
    },

    settings(core) {
        core.settings.define({
            key: SETTING_KEY,
            label: 'Confirm deals that dip into upkeep',
            description: 'Ask for confirmation when offering items in an outgoing deal or accepting an incoming deal would leave stock below tick consumption and military upkeep.',
            type: 'bool',
            default: true,
            section: 'Deals',
        });
    },

    init(core) {
        const deals = incomingDealsFromDocument(document).map((record) => ({
            form: record.form, button: record.accept,
            read: () => ({ ...record, operation: 'Accept deal' }),
            verb: 'Accept', target: 'this deal',
        }));
        const forms = [...document.querySelectorAll('#content form')];
        // makedeal.php is itself restricted to active State Controlled
        // economies. Only adding items/money spends stock, not finalizing.
        for (const form of forms) {
            if (!form.querySelector('input[name="token_makedeal"]')) continue;
            const button = form.querySelector('[name="offeritem"], [name="askitem"], [name="offermoney"]');
            if (!button) continue;
            deals.push({
                form, button, read: () => outgoingDealFromForm(form, button),
                verb: 'Add', target: 'this to the deal',
            });
        }
        if (!deals.length) return;
        const el = core.el.bind(core);
        let pending = false;

        core.addStyle(`
            form.clop-deal-checking { opacity: .7; pointer-events: none; }
        `);

        function setChecking(record, checking) {
            record.form.classList.toggle('clop-deal-checking', checking);
            if (checking) {
                record.oldLabel = record.button.value || record.button.textContent;
                if ('value' in record.button) record.button.value = 'Checking safety…';
                else record.button.textContent = 'Checking safety…';
                // Freeze the submitted values and other draft operations
                // while fetching/confirming (all forms share a POST token).
                record.controls = forms.flatMap((form) => [...form.querySelectorAll('input, select, button, textarea')])
                    .map((control) => ({ control, disabled: control.disabled }));
                for (const { control } of record.controls) control.disabled = true;
            } else {
                if (record.oldLabel !== undefined) {
                    if ('value' in record.button) record.button.value = record.oldLabel;
                    else record.button.textContent = record.oldLabel;
                    delete record.oldLabel;
                }
                for (const { control, disabled } of record.controls || []) control.disabled = disabled;
                record.controls = null;
            }
        }

        function submitDeal(record) {
            setChecking(record, false);
            // Native form.submit() omits submit-button fields, but the server
            // dispatches on their names; add the chosen successful field.
            record.form.appendChild(el('input', {
                type: 'hidden',
                name: record.button.name,
                value: record.button.value || record.button.textContent,
            }));
            HTMLFormElement.prototype.submit.call(record.form);
        }

        function confirmRisks(record, deal, risks, affordability) {
            const warnings = warningGroup(core, [upkeepWarningSection(core, risks)]);
            return core.confirm(affordabilityDialogOptions(core, affordability, {
                title: `Review action: ${deal.operation}`,
                operation: deal.operation,
                warningCount: risks.length,
                body: el('div', {}, [
                    ...(warnings ? [warnings] : []),
                    el('p', {}, [`${record.verb} ${record.target} anyway?`]),
                ]),
                confirmLabel: `${record.verb} anyway`,
            }));
        }

        for (const record of deals) {
            let clickedSubmitter = null;
            record.form.addEventListener('click', (event) => {
                const submitter = event.target.closest('input[type="submit"], button[type="submit"]');
                if (submitter && submitter.form === record.form) clickedSubmitter = submitter;
            });
            record.form.addEventListener('submit', async (event) => {
                const submitter = event.submitter || clickedSubmitter;
                clickedSubmitter = null;
                if (submitter !== record.button) return;

                event.preventDefault();
                if (pending) return;
                pending = true;
                setChecking(record, true);
                try {
                    let stats;
                    let deal;
                    try {
                        deal = record.read();
                        if (!deal) { submitDeal(record); return; }
                        stats = await fetchResourceStats(core);
                    } catch (error) {
                        if (await core.confirm({
                            title: 'Deal safety unavailable',
                            body: el('div', {}, [
                                el('div', { class: 'alert alert-danger' }, [
                                    `4clopX could not check this deal against your current funds, inventory and upkeep ` +
                                    `(${String(error.message || error)}).`,
                                ]),
                                el('p', {}, [`${record.verb} ${record.target} without safety checks?`]),
                            ]),
                            confirmLabel: `${record.verb} without protection`,
                        })) submitDeal(record);
                        return;
                    }

                    const risks = core.settings.get(SETTING_KEY) ? projectDealRisks(deal, stats) : [];
                    const affordability = projectDealAffordability(deal, stats);
                    if ((!risks.length && !affordability.length)
                        || await confirmRisks(record, deal, risks, affordability)) submitDeal(record);
                } finally {
                    setChecking(record, false);
                    pending = false;
                }
            });
        }
    },
};
