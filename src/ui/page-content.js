// Shared stock-page rendering for Overview refreshes and action responses.
export function contentSignature(doc) {
    const content = doc && doc.querySelector && doc.querySelector('#content');
    return content ? content.innerHTML : null;
}

export function replacePageContent(currentDoc, sourceDoc, previousSignature, { omitFeedback = false } = {}) {
    const current = currentDoc && currentDoc.querySelector && currentDoc.querySelector('#content');
    const source = sourceDoc && sourceDoc.querySelector && sourceDoc.querySelector('#content');
    if (!current || !source) {
        return { available: false, changed: false, signature: previousSignature };
    }
    const signature = source.innerHTML;
    if (signature === previousSignature) return { available: true, changed: false, signature };

    // Leave the response document intact so the feedback framework can read it.
    const nodes = [...source.childNodes].filter((node) => !omitFeedback
        || !node.matches?.('.alert-danger, .alert-info'));
    current.replaceChildren(...nodes.map((node) => currentDoc.importNode(node, true)));
    return { available: true, changed: true, signature };
}

export function initialiseMasonry(root) {
    if (typeof window === 'undefined') return;
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const Masonry = pageWindow.Masonry || window.Masonry;
    if (typeof Masonry !== 'function') return;
    // The game's data-attribute bootstrap only runs on initial page load.
    for (const container of root.querySelectorAll('.js-masonry')) {
        let options = {};
        try {
            options = JSON.parse(container.getAttribute('data-masonry-options') || '{}');
        } catch (e) { /* retain Masonry's defaults */ }
        try { new Masonry(container, options); } catch (e) { /* layout is optional */ }
    }
}
