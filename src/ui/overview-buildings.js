import { phpInteger } from '../adapters/actions.js';
import { executeDynamicRequest } from './dynamic-request.js';

const OPERATIONS = {
    disable: { amount: 'disableamount', pending: 'Disabling…', complete: 'Buildings disabled' },
    reenable: { amount: 'reenableamount', pending: 'Re-enabling…', complete: 'Buildings re-enabled' },
    recycle: { amount: 'recycleamount', pending: 'Destroying…', complete: 'Buildings destroyed' },
};

export function destroyBuildingConfirmation(core, name, amount, warning = '') {
    return {
        title: `Destroy ${name} × ${core.commas(amount)}?`,
        body: [
            core.el('div', { class: 'alert alert-danger' }, [
                core.el('strong', {}, ['This cannot be undone.']),
                ...(warning ? [core.el('p', {}, [warning])] : []),
            ]),
            core.el('p', {}, ['Are you sure you want to destroy these buildings?']),
        ],
        confirmLabel: 'Destroy',
        confirmClass: 'btn-danger',
        cancelLabel: 'Cancel',
    };
}

export function bindOverviewBuildings(core, doc = document) {
    const boundForms = new WeakSet();
    let pending = false;
    core.addStyle('form.clop-building-pending { opacity: .7; pointer-events: none; }');

    function bind() {
        for (const form of doc.querySelectorAll('form[name="recycle"]')) {
            if (boundForms.has(form) || !form.querySelector('input[name="token_overview"]')
                || !form.querySelector('input[name="resource_id"]')) continue;
            boundForms.add(form);
            for (const { amount } of Object.values(OPERATIONS)) {
                const input = form.querySelector(`input[name="${amount}"]`);
                if (!input) continue;
                input.placeholder = '1';
                if (input.value === '1') input.value = '';
                input.defaultValue = '';
            }
            const destroy = form.querySelector('input[name="recycle"][type="submit"]');
            // Replace the stock browser confirm, but retain its live warning
            // about satisfaction rather than assuming old backend values.
            const stockWarning = destroy?.getAttribute('onclick')?.match(
                /You will (?:gain|lose) [\d,.]+ satisfaction for each building you destroy!/i)?.[0] || '';
            destroy?.removeAttribute('onclick');
            let clickedSubmitter = null;
            form.addEventListener('click', (event) => {
                const button = event.target.closest('input[type="submit"], button[type="submit"]');
                if (button?.form === form) clickedSubmitter = button;
            });
            form.addEventListener('submit', async (event) => {
                const submitter = event.submitter || clickedSubmitter;
                clickedSubmitter = null;
                // Without a known intent, do not guess between destructive and
                // reversible controls sharing the same form.
                const operation = Object.hasOwn(OPERATIONS, submitter?.name)
                    ? OPERATIONS[submitter.name] : null;
                event.preventDefault();
                if (!operation || pending) return;
                pending = true;
                const oldLabel = submitter.value;
                form.classList.add('clop-building-pending');
                try {
                    // Snapshot before confirmation: a background refresh or edit
                    // must not change the quantity the user agreed to destroy.
                    const params = new FormData(form);
                    params.set(submitter.name, oldLabel);
                    if (!String(params.get(operation.amount) ?? '').trim()) params.set(operation.amount, '1');
                    const amount = phpInteger(params.get(operation.amount));
                    if (submitter.name === 'recycle') {
                        const name = form.closest('tr')?.querySelector('td')?.textContent.trim()
                            || oldLabel.replace(/^Destroy\s+/i, '');
                        if (!await core.confirm(destroyBuildingConfirmation(core, name, amount, stockWarning))) return;
                    }
                    submitter.value = operation.pending;
                    await executeDynamicRequest(core, {
                        send: () => core.http.postForm('overview.php', params),
                        refresh: () => core.overview.refresh(),
                        successTitle: operation.complete,
                        errorTitle: 'Building update failed',
                        fallbackMessage: 'The building update was processed.',
                    });
                } finally {
                    pending = false;
                    submitter.value = oldLabel;
                    form.classList.remove('clop-building-pending');
                }
            });
        }
    }
    bind();
    core.events.on('overview:contentReplaced', bind);
}
