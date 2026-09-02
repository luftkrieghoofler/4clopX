// Shared result feedback for dynamic operations.  Stock PHP responses render
// errors and informational results at the top of #content; dynamic controls
// instead need feedback that remains visible at any scroll position.

export const DEFAULT_TOAST_DURATION = 2000;

function text(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function messagesIn(doc, alertSelector, itemSelector) {
    if (!doc || !doc.querySelectorAll) return [];
    const messages = [];
    for (const alert of doc.querySelectorAll(alertSelector)) {
        const items = alert.querySelectorAll ? [...alert.querySelectorAll(itemSelector)] : [];
        if (items.length) {
            for (const item of items) {
                const message = text(item.textContent);
                if (message) messages.push(message);
            }
        } else {
            const message = text(alert.textContent);
            if (message) messages.push(message);
        }
    }
    return messages;
}

export function feedbackMessagesFromDocument(doc) {
    return {
        errors: messagesIn(doc, '#content > .alert-danger', '.error'),
        infos: messagesIn(doc, '#content > .alert-info', '.info'),
    };
}

function normalizedMessages(value) {
    return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);
}

export const feedbackModule = {
    name: 'feedback',
    matches: () => true,

    init(core) {
        core.addStyle(`
            #clop-feedback-toasts { position: fixed; right: 18px; bottom: 18px; z-index: 10040; display: flex; flex-direction: column; align-items: flex-end; width: min(420px, calc(100vw - 36px)); pointer-events: none; }
            .clop-feedback-toast { position: relative; box-sizing: border-box; width: 100%; margin: 7px 0 0; padding: 11px 32px 12px 13px; overflow: hidden; box-shadow: 0 3px 12px rgba(0,0,0,.35); pointer-events: auto; opacity: 1; transform: translateY(0); transition: opacity .16s ease, transform .16s ease; }
            .clop-feedback-toast:focus { outline: 2px solid currentColor; outline-offset: 2px; }
            .clop-feedback-toast.clop-feedback-toast-leaving { opacity: 0; transform: translateY(7px); }
            .clop-feedback-toast-title { display: block; margin-bottom: 3px; }
            .clop-feedback-toast .close { position: absolute; top: 5px; right: 8px; }
            .clop-feedback-toast ul { margin: 4px 0 0; padding-left: 20px; }
            .clop-feedback-toast-progress { position: absolute; left: 0; bottom: 0; width: 100%; height: 3px; background: currentColor; opacity: .48; transform: scaleX(1); transform-origin: left center; animation: clop-feedback-toast-progress var(--clop-toast-duration) linear forwards; }
            .clop-feedback-toast.clop-feedback-toast-paused .clop-feedback-toast-progress { animation-play-state: paused; }
            @keyframes clop-feedback-toast-progress { from { transform: scaleX(1); } to { transform: scaleX(0); } }
            @media (max-width: 600px) { #clop-feedback-toasts { right: 10px; bottom: 10px; width: calc(100vw - 20px); } }
            @media (prefers-reduced-motion: reduce) { .clop-feedback-toast { transition: none; } .clop-feedback-toast-progress { animation-timing-function: steps(20); } }
        `);

        const host = core.el('div', {
            id: 'clop-feedback-toasts',
            'aria-live': 'polite',
            'aria-relevant': 'additions',
        });
        document.body.appendChild(host);

        function messageContent(messages) {
            if (messages.length === 1) return [messages[0]];
            return [core.el('ul', {}, messages.map((message) => core.el('li', {}, [message])))];
        }

        function toast(messages, options = {}) {
            const values = normalizedMessages(messages);
            if (!values.length) return null;
            const duration = Number.isFinite(Number(options.duration))
                ? Math.max(250, Number(options.duration))
                : DEFAULT_TOAST_DURATION;
            const kind = options.kind === 'info' ? 'info' : 'success';
            const closeButton = core.el('button', {
                type: 'button',
                class: 'close',
                'aria-label': 'Dismiss notification',
                html: '&times;',
            });
            const progress = core.el('div', {
                class: 'clop-feedback-toast-progress',
                'aria-hidden': 'true',
            });
            const toastNode = core.el('div', {
                class: `alert alert-${kind} clop-feedback-toast`,
                role: 'status',
                tabindex: '0',
                style: `--clop-toast-duration:${duration}ms`,
            }, [
                closeButton,
                core.el('strong', { class: 'clop-feedback-toast-title' }, [
                    options.title || (kind === 'info' ? 'Information' : 'Done'),
                ]),
                ...messageContent(values),
                progress,
            ]);

            let remaining = duration;
            let startedAt = null;
            let timer = null;
            let closed = false;
            let hovered = false;
            let focused = false;

            function remove() {
                if (closed) return;
                closed = true;
                clearTimeout(timer);
                document.removeEventListener('visibilitychange', syncTimer);
                toastNode.classList.add('clop-feedback-toast-leaving');
                setTimeout(() => toastNode.remove(), 170);
            }

            function pause() {
                if (timer !== null) {
                    remaining = Math.max(0, remaining - (Date.now() - startedAt));
                    clearTimeout(timer);
                    timer = null;
                }
                toastNode.classList.add('clop-feedback-toast-paused');
            }

            function resume() {
                if (closed || timer !== null) return;
                if (remaining <= 0) {
                    remove();
                    return;
                }
                toastNode.classList.remove('clop-feedback-toast-paused');
                startedAt = Date.now();
                timer = setTimeout(remove, remaining);
            }

            function syncTimer() {
                if (document.hidden || hovered || focused) pause();
                else resume();
            }

            closeButton.addEventListener('click', remove);
            toastNode.addEventListener('mouseenter', () => { hovered = true; syncTimer(); });
            toastNode.addEventListener('mouseleave', () => { hovered = false; syncTimer(); });
            toastNode.addEventListener('focusin', () => { focused = true; syncTimer(); });
            toastNode.addEventListener('focusout', () => {
                setTimeout(() => {
                    focused = toastNode.contains(document.activeElement);
                    syncTimer();
                }, 0);
            });
            document.addEventListener('visibilitychange', syncTimer);
            host.appendChild(toastNode);
            syncTimer();
            return toastNode;
        }

        function error(messages, options = {}) {
            const values = normalizedMessages(messages);
            if (!values.length) return Promise.resolve();
            return core.alert({
                title: options.title || 'Something went wrong',
                body: core.el('div', { class: 'alert alert-danger' }, messageContent(values)),
                dismissLabel: options.dismissLabel || 'Close',
            });
        }

        function fromDocument(sourceDoc, options = {}) {
            const messages = feedbackMessagesFromDocument(sourceDoc);
            const errors = [
                ...messages.errors,
                ...normalizedMessages(options.additionalErrors || []),
            ];
            if (errors.length) {
                const body = [
                    core.el('div', { class: 'alert alert-danger' },
                        messageContent(errors)),
                ];
                if (messages.infos.length) {
                    body.push(core.el('div', { class: 'alert alert-info' },
                        messageContent(messages.infos)));
                }
                return core.alert({
                    title: options.errorTitle || 'Action failed',
                    body,
                    dismissLabel: options.dismissLabel || 'Close',
                });
            }
            if (messages.infos.length) {
                toast(messages.infos, {
                    title: options.successTitle || 'Action complete',
                    duration: options.duration,
                    kind: options.kind,
                });
            } else if (options.fallbackMessage) {
                toast(options.fallbackMessage, {
                    title: options.successTitle || 'Action complete',
                    duration: options.duration,
                    kind: options.kind,
                });
            }
            return Promise.resolve(messages);
        }

        core.feedback = {
            toast,
            success: (messages, options) => toast(messages, { ...options, kind: 'success' }),
            info: (messages, options) => toast(messages, { ...options, kind: 'info' }),
            error,
            fromDocument,
            messagesFromDocument: feedbackMessagesFromDocument,
        };
    },
};
