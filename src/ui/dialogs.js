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
            .clop-confirm-panel .panel-heading { font-size: 16px; }
            .clop-confirm-panel .panel-heading .close { line-height: 1; }
            .clop-confirm-panel .panel-body { max-height: 65vh; overflow-y: auto; }
            .clop-confirm-panel .panel-body > :last-child { margin-bottom: 0; }
            .clop-confirm-actions { text-align: right; }
            .clop-confirm-actions .btn + .btn { margin-left: 6px; }
            .clop-confirm-risk-list { margin: 10px 0 0; padding-left: 22px; }
        `);

        let sequence = 0;
        let queue = Promise.resolve();

        function show(options = {}) {
            return new Promise((resolve) => {
                const previousFocus = document.activeElement;
                const id = `clop-confirm-title-${++sequence}`;
                const bodyId = `clop-confirm-body-${sequence}`;
                let settled = false;
                let cleanup = null;

                const body = core.el('div', { id: bodyId, class: 'panel-body' });
                appendContent(body, options.body || options.message || 'Are you sure?');

                const cancel = core.el('button', {
                    type: 'button',
                    class: 'btn btn-default',
                }, [options.cancelLabel || 'Cancel']);
                const proceed = core.el('button', {
                    type: 'button',
                    class: `btn ${options.confirmClass || 'btn-danger'}`,
                }, [options.confirmLabel || 'Continue anyway']);
                const close = core.el('button', {
                    type: 'button',
                    class: 'close',
                    'aria-label': 'Cancel',
                    html: '&times;',
                });
                const panel = core.el('div', {
                    class: 'panel panel-default clop-confirm-panel',
                    role: 'alertdialog',
                    'aria-modal': 'true',
                    'aria-labelledby': id,
                    'aria-describedby': bodyId,
                }, [
                    core.el('div', { class: 'panel-heading' }, [
                        close,
                        core.el('strong', { id }, [options.title || 'Please confirm']),
                    ]),
                    body,
                    core.el('div', { class: 'panel-footer clop-confirm-actions' }, [cancel, proceed]),
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
                    return [...panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
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
                proceed.addEventListener('click', () => finish(true));
                overlay.addEventListener('click', (event) => {
                    if (event.target === overlay) finish(false);
                });
                document.addEventListener('keydown', onKey, true);
                document.body.classList.add('clop-confirm-open');
                document.body.appendChild(overlay);
                if (options.onOpen) {
                    try {
                        cleanup = options.onOpen({ overlay, panel, body, proceed, cancel }) || null;
                    } catch (error) {
                        console.warn('[4clopX] confirmation setup failed:', error);
                    }
                }
                cancel.focus();
            });
        }

        // Serialising dialogs prevents two independent async safety checks
        // from stacking overlays.  Sequential checks (currently the two
        // marketplace protections) retain their separate acknowledgements.
        core.confirm = (options) => {
            const result = queue.then(() => show(options));
            queue = result.then(() => undefined, () => undefined);
            return result;
        };
    },
};
