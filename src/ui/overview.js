// Live rendering for overview.php.  The live-update sweep already fetches a
// complete Overview document as its header/resource probe, so the active
// Overview tab can adopt that document without another request.  If another
// tab is the elected poller, this tab follows the cycle-complete signal with
// one serialized GET of its own; full page HTML (and its form tokens) is never
// persisted in cross-tab storage.

import { parseResourceStats, publishResourceStats } from '../adapters/overview.js';
import { isLoggedInDoc } from '../adapters/session.js';

export function overviewContentSignature(doc) {
    const content = doc && doc.querySelector && doc.querySelector('#content');
    return content ? content.innerHTML : null;
}

export function replaceOverviewContent(currentDoc, sourceDoc, previousSignature) {
    const current = currentDoc && currentDoc.querySelector
        && currentDoc.querySelector('#content');
    const source = sourceDoc && sourceDoc.querySelector
        && sourceDoc.querySelector('#content');
    if (!current || !source) {
        return { available: false, changed: false, signature: previousSignature };
    }

    const signature = source.innerHTML;
    if (signature === previousSignature) {
        return { available: true, changed: false, signature };
    }

    const imported = [...source.childNodes].map((node) => currentDoc.importNode(node, true));
    current.replaceChildren(...imported);
    return { available: true, changed: true, signature };
}

function initialiseMasonry(root) {
    if (typeof window === 'undefined') return;
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const Masonry = pageWindow.Masonry || window.Masonry;
    if (typeof Masonry !== 'function') return;
    // Masonry's data-attribute bootstrap only runs on the initial page load.
    // Recreate those layouts after inserting freshly fetched panels.
    for (const container of root.querySelectorAll('.js-masonry')) {
        let options = {};
        try {
            options = JSON.parse(container.getAttribute('data-masonry-options') || '{}');
        } catch (e) { /* retain Masonry's defaults */ }
        try { new Masonry(container, options); } catch (e) { /* layout is optional */ }
    }
}

export const overviewModule = {
    name: 'overview',

    matches(page) {
        return page === 'overview.php';
    },

    init(core) {
        let signature = overviewContentSignature(document);
        let networkRefresh = null;

        function applyDocument(sourceDoc) {
            const result = replaceOverviewContent(document, sourceDoc, signature);
            signature = result.signature;
            if (!result.available) {
                throw new Error('Could not find the Overview content container.');
            }
            if (!result.changed) return false;

            // Consumers reattach page-local enhancements (notably action
            // safety and low-buffer badges) through this single hook.
            core.events.emit('overview:contentReplaced', { document: sourceDoc });
            // Give synchronous hooks and resolved promises a chance to add
            // their annotations before Masonry measures the new action cards.
            setTimeout(() => initialiseMasonry(document), 0);
            return true;
        }

        async function refresh() {
            if (networkRefresh) return networkRefresh;
            networkRefresh = (async () => {
                const sourceDoc = await core.http.getDoc('overview.php');
                if (!isLoggedInDoc(sourceDoc)) throw new Error('The game session has expired.');
                const changed = applyDocument(sourceDoc);
                // Keep all existing cache, badge, shortcut, notification and
                // safety consumers current when this tab had to fetch its own
                // copy rather than receiving the leader's in-memory document.
                publishResourceStats(core, parseResourceStats(sourceDoc));
                return { changed, document: sourceDoc };
            })().finally(() => { networkRefresh = null; });
            return networkRefresh;
        }

        // Public seam for the upcoming in-place favourite-action and building
        // mutations: after their POST, they can call this same refresh path.
        core.overview = { refresh, applyDocument };

        core.events.on('overview:document', ({ document: sourceDoc } = {}) => {
            if (!sourceDoc) return;
            try { applyDocument(sourceDoc); } catch (error) {
                console.warn('[4clopX] could not refresh the Overview page:', error);
            }
        });
        core.events.on('live:polled', ({ remote } = {}) => {
            if (!remote || !core.settings.get('live.enabled')) return;
            refresh().catch((error) => {
                console.warn('[4clopX] could not refresh the Overview page:', error);
            });
        });
    },
};
