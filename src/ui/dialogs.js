// Shared, Promise-based confirmation UI for userscript safety checks.  It
// uses the game's Bootstrap panel/button classes for theme compatibility,
// but owns the overlay and focus handling so it does not depend on the
// page-global jQuery/Bootstrap JavaScript from the userscript sandbox.

function appendContent(parent, content) {
    for (const child of Array.isArray(content) ? content : [content]) {
        if (child === null || child === undefined) continue;
        if (typeof child === 'string') parent.appendChild(document.createTextNode(child));
        else parent.appendChild(child);
    }
}

export const dialogsModule = {
    name: 'dialogs',
    matches: () => true,

    init(core) {
        core.addStyle(`
            body.clop-confirm-open { overflow: hidden; }
            .clop-confirm-overlay { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 10050; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 20px; background: rgba(0,0,0,.58); }
            .clop-confirm-panel { width: 560px; max-width: 92vw; margin: 0; text-align: left; }
            .clop-confirm-panel .panel-heading { display: flex; align-items: flex-start; gap: 10px; font-size: 16px; }
            .clop-confirm-heading-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
            .clop-confirm-source { display: block; margin-bottom: 3px; font-size: 12px; font-weight: normal; line-height: 1.4; opacity: .75; }
            .clop-confirm-panel .panel-heading .close { order: 1; flex: none; float: none; line-height: 1; }
            .clop-confirm-panel .panel-body { max-height: 65vh; overflow-y: auto; }
            .clop-confirm-panel .panel-body > :last-child { margin-bottom: 0; }
            .clop-confirm-actions { text-align: right; }
            .clop-confirm-actions .btn + .btn { margin-left: 6px; }
            .clop-confirm-risk-list { margin: 10px 0 0; padding-left: 22px; }
            .clop-confirm-risk-list + p { margin-top: 12px; }
            .clop-warning-section + .clop-warning-section { margin-top: 14px; }
            .clop-warning-heading { display: block; }
            .clop-warning-section .clop-confirm-risk-list { margin: 6px 0 0; }
            .clop-warning-section li + li { margin-top: 4px; }
            .clop-warning-description { margin-top: 3px; }
            .clop-confirm-review { margin-top: 14px; }
            .clop-confirm-review > summary { display: list-item; cursor: pointer; list-style: disclosure-closed inside; }
            .clop-confirm-review[open] > summary { list-style-type: disclosure-open; }
            .clop-confirm-review-content { margin-top: 12px; }
        `);

        let sequence = 0;
        let queue = Promise.resolve();

        function show(options = {}) {
            return new Promise((resolve) => {
                const alertOnly = options.alertOnly === true;
                const dismissPrimary = alertOnly || options.dismissPrimary === true;
                const previousFocus = document.activeElement;
                const id = `clop-confirm-title-${++sequence}`;
                const sourceId = `clop-confirm-source-${sequence}`;
                const bodyId = `clop-confirm-body-${sequence}`;
                let settled = false;
                let cleanup = null;

                const body = core.el('div', { id: bodyId, class: 'panel-body' });
                appendContent(body, options.body || options.message || 'Are you sure?');

                const cancel = core.el('button', {
                    type: 'button',
                    class: `btn ${dismissPrimary ? 'btn-primary' : 'btn-default'}`,
                }, [alertOnly ? (options.dismissLabel || 'Close') : (options.cancelLabel || 'Cancel')]);
                const proceed = core.el('button', {
                    type: 'button',
                    class: `btn ${options.confirmClass || 'btn-danger'}`,
                }, [options.confirmLabel || 'Continue anyway']);
                const close = core.el('button', {
                    type: 'button',
                    class: 'close',
                    'aria-label': alertOnly ? 'Dismiss' : 'Cancel',
                    html: '&times;',
                });
                let review = null;
                if (!alertOnly && options.reviewBeforeConfirm) {
                    const reviewBody = core.el('div', { class: 'clop-confirm-review-content' });
                    appendContent(reviewBody, options.reviewBeforeConfirm.body);
                    reviewBody.appendChild(core.el('div', { class: 'clop-confirm-actions' }, [proceed]));
                    review = core.el('details', { class: 'clop-confirm-review' }, [
                        core.el('summary', {}, [options.reviewBeforeConfirm.summary]),
                        reviewBody,
                    ]);
                    // A collapsed disclosure must never offer a hidden submit
                    // target to keyboard navigation or programmatic clicks.
                    proceed.disabled = true;
                    review.addEventListener('toggle', () => { proceed.disabled = !review.open; });
                    body.appendChild(review);
                }
                const panel = core.el('div', {
                    class: 'panel panel-default clop-confirm-panel',
                    role: 'alertdialog',
                    'aria-modal': 'true',
                    'aria-labelledby': `${sourceId} ${id}`,
                    'aria-describedby': bodyId,
                }, [
                    core.el('div', { class: 'panel-heading' }, [
                        close,
                        core.el('div', { class: 'clop-confirm-heading-text' }, [
                            core.el('span', { id: sourceId, class: 'clop-confirm-source' }, [
                                options.source === 'game' ? 'Game response' : '4clopX',
                            ]),
                            core.el('strong', { id }, [options.title || 'Please confirm']),
                        ]),
                    ]),
                    body,
                    core.el('div', { class: 'panel-footer clop-confirm-actions' },
                        alertOnly || review ? [cancel]
                            : dismissPrimary ? [proceed, cancel] : [cancel, proceed]),
                ]);
                const overlay = core.el('div', { class: 'clop-confirm-overlay' }, [panel]);

                function finish(value) {
                    if (settled) return;
                    settled = true;
                    document.removeEventListener('keydown', onKey, true);
                    if (cleanup) {
                        try { cleanup(); } catch (error) {
                            console.warn('[4clopX] confirmation cleanup failed:', error);
                        }
                    }
                    overlay.remove();
                    document.body.classList.remove('clop-confirm-open');
                    if (previousFocus && previousFocus.isConnected && previousFocus.focus) previousFocus.focus();
                    resolve(value);
                }

                function focusable() {
                    return [...panel.querySelectorAll('button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
                        .filter((node) => !review || review.open || !review.contains(node)
                            || node === review.firstElementChild);
                }

                function onKey(event) {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        finish(false);
                        return;
                    }
                    if (event.key !== 'Tab') return;
                    const items = focusable();
                    if (!items.length) return;
                    const first = items[0];
                    const last = items[items.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    }
                }

                cancel.addEventListener('click', () => finish(false));
                close.addEventListener('click', () => finish(false));
                if (!alertOnly) proceed.addEventListener('click', () => {
                    if (!review || review.open) finish(true);
                });
                overlay.addEventListener('click', (event) => {
                    if (event.target === overlay) finish(false);
                });
                document.addEventListener('keydown', onKey, true);
                document.body.classList.add('clop-confirm-open');
                document.body.appendChild(overlay);
                if (options.onOpen) {
                    try {
                        cleanup = options.onOpen({
                            overlay, panel, body,
                            proceed: alertOnly ? null : proceed,
                            cancel,
                        }) || null;
                    } catch (error) {
                        console.warn('[4clopX] confirmation setup failed:', error);
                    }
                }
                cancel.focus();
            });
        }

        // Serialising dialogs prevents two independent async safety checks
        // from stacking overlays.
        core.confirm = (options) => {
            const result = queue.then(() => show(options));
            queue = result.then(() => undefined, () => undefined);
            return result;
        };
        core.alert = (options) => {
            const result = queue.then(() => show({ ...options, alertOnly: true }));
            queue = result.then(() => undefined, () => undefined);
            return result;
        };
    },
};
