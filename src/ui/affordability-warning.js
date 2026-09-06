// Wrap an existing safety dialog so its warnings can be reviewed before an
// explicitly requested attempt. The caller submits only when it resolves true.
export function affordabilityDialogOptions(core, shortages, options, notPerformed = 'Action was not performed:') {
    if (!shortages || !shortages.length) return options;
    const el = core.el.bind(core);
    const count = options.warningCount || 0;
    return {
        ...options,
        title: 'Not enough resources',
        body: [
            el('strong', {}, [notPerformed]),
            el('ul', { class: 'clop-confirm-risk-list' }, shortages.map((item) => el('li', {}, [
                el('strong', {}, [`${item.name}:`]),
                ' need ', el('strong', {}, [core.commas(item.required)]),
                ', stock ', core.commas(item.stock),
                ' — short by ', el('strong', {}, [core.commas(item.shortage)]),
            ]))),
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
