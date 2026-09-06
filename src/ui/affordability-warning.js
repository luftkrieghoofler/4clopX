// Wrap an existing safety dialog so its warnings can be reviewed before an
// explicitly requested attempt. The caller submits only when it resolves true.
import { warningSection } from './warning-content.js';

export function affordabilityDialogOptions(core, shortages, options) {
    if (!shortages || !shortages.length) return options;
    const el = core.el.bind(core);
    const count = options.warningCount || 0;
    return {
        ...options,
        title: `Action was not performed${options.operation ? `: ${options.operation}` : ''}`,
        body: [
            el('div', { class: 'alert alert-danger' }, [
                warningSection(core, 'Not enough resources', shortages.map((item) => el('li', {}, [
                    el('strong', {}, [`${item.name}:`]),
                    ' need ', el('strong', {}, [core.commas(item.required)]),
                    ', stock ', core.commas(item.stock),
                    ' — short by ', el('strong', {}, [core.commas(item.shortage)]),
                ]))),
            ]),
            el('p', {}, ['The action was not sent to the server.']),
        ],
        cancelLabel: 'OK',
        dismissPrimary: true,
        confirmLabel: count ? 'Proceed anyway' : 'Attempt anyway',
        confirmClass: count ? 'btn-default' : 'btn-link',
        reviewBeforeConfirm: count ? {
            summary: `Attempt anyway — review ${count} safety warning${count === 1 ? '' : 's'}`,
            body: options.body,
        } : null,
    };
}
