import { incomingDealsFromDocument } from '../adapters/deals.js';
import { fetchResourceStats } from '../adapters/overview.js';
import { projectDealRisks } from '../lib/deal-safety.js';
import { upkeepWarningContent } from './upkeep-warning.js';

const SETTING_KEY = 'deals.confirmBelowUpkeep';

export const dealsModule = {
    name: 'deals',

    matches(page) {
        return page === 'deals.php';
    },

    settings(core) {
        core.settings.define({
            key: SETTING_KEY,
            label: 'Confirm deals that dip into upkeep',
            description: 'Ask for confirmation when accepting a deal would leave resource stock below tick consumption and military upkeep.',
            type: 'bool',
            default: true,
            section: 'Deals',
        });
    },

    init(core) {
        const deals = incomingDealsFromDocument(document);
        if (!deals.length) return;
        const el = core.el.bind(core);

        core.addStyle(`
            form.clop-deal-checking { opacity: .7; pointer-events: none; }
        `);

        function setChecking(record, checking) {
            record.form.classList.toggle('clop-deal-checking', checking);
            if (checking) {
                record.accept.dataset.clopOldLabel = record.accept.value || record.accept.textContent;
                if ('value' in record.accept) record.accept.value = 'Checking safety…';
                else record.accept.textContent = 'Checking safety…';
            } else {
                const old = record.accept.dataset.clopOldLabel;
                if (old !== undefined) {
                    if ('value' in record.accept) record.accept.value = old;
                    else record.accept.textContent = old;
                    delete record.accept.dataset.clopOldLabel;
                }
            }
        }

        function submitAccept(record) {
            // Native form.submit() omits submit-button fields, but the server
            // dispatches on `acceptdeal`; add an equivalent successful field.
            record.form.appendChild(el('input', {
                type: 'hidden',
                name: 'acceptdeal',
                value: record.accept.dataset.clopOldLabel || record.accept.value || 'Accept Deal',
            }));
            HTMLFormElement.prototype.submit.call(record.form);
        }

        function confirmRisks(risks) {
            return core.confirm({
                title: 'Upkeep reserve at risk',
                body: el('div', {}, [
                    ...upkeepWarningContent(
                        core, 'Accepting this deal would leave insufficient stock', risks),
                    el('p', {}, ['Accept this deal anyway?']),
                ]),
                confirmLabel: 'Accept anyway',
            });
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
                if (!submitter || submitter.name !== 'acceptdeal'
                    || !core.settings.get(SETTING_KEY)) return;

                event.preventDefault();
                if (record.form.classList.contains('clop-deal-checking')) return;
                setChecking(record, true);
                try {
                    let stats;
                    try {
                        stats = await fetchResourceStats(core);
                    } catch (error) {
                        if (await core.confirm({
                            title: 'Deal safety unavailable',
                            body: el('div', {}, [
                                el('div', { class: 'alert alert-danger' }, [
                                    `4clopX could not load your current stock and upkeep ` +
                                    `(${String(error.message || error)}).`,
                                ]),
                                el('p', {}, ['Accept this deal without upkeep protection?']),
                            ]),
                            confirmLabel: 'Accept without protection',
                        })) submitAccept(record);
                        return;
                    }

                    const risks = projectDealRisks(record, stats);
                    if (!risks.length || await confirmRisks(risks)) submitAccept(record);
                } finally {
                    setChecking(record, false);
                }
            });
        }
    },
};
