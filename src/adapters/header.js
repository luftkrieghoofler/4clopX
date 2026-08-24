// Header badge adapter.  The stock navbar renders every notification count
// (messages, alliance messages, deals, incoming attacks, polls) on every
// page load, so "checking for news" is a single GET of any cheap page that
// includes header.php — guide.php is static text plus the header and needs
// no nation, making it the lightest probe.
//
// Badge text is rendered by backend_header.php as " (N)" when nonzero and
// "" when zero, so text is copied verbatim and digits are parsed only for
// change detection.  Badges the userscript adds itself (.clop-menu-badge)
// are ignored here.

export const HEADER_PROBE_PAGE = 'guide.php';

// Stable identity for a navbar anchor carrying a badge: its href, or for
// dropdown toggles (href="#") the first word of its label ("Alliance",
// "Capitalism", "War", "Feedback").
function badgeKey(a) {
    const href = a.getAttribute('href');
    if (href && href !== '#') return href;
    return `menu:${(a.textContent || '').trim().split(/\s+/)[0]}`;
}

function badgeCount(text) {
    const m = text.match(/[\d,]+/);
    return m ? parseInt(m[0].replace(/,/g, ''), 10) : 0;
}

const stockBadge = (a) => a.querySelector(':scope > .badge:not(.clop-menu-badge)');

// {key: {text, count, label}} for every navbar anchor with a stock badge.
// Plain object so it can round-trip through JSON (cross-tab sharing).
export function headerBadges(doc) {
    const out = {};
    for (const a of doc.querySelectorAll('nav.navbar a')) {
        const badge = stockBadge(a);
        if (!badge) continue;
        out[badgeKey(a)] = {
            text: badge.textContent,
            count: badgeCount(badge.textContent),
            label: (a.textContent || '').replace(badge.textContent, ' ').replace(/\s+/g, ' ').trim(),
        };
    }
    return out;
}

// Apply captured badge values to the live header.
// Returns the changes as [{key, label, from, to}].
export function applyHeaderBadges(values) {
    const changes = [];
    for (const a of document.querySelectorAll('nav.navbar a')) {
        const badge = stockBadge(a);
        if (!badge) continue;
        const f = values[badgeKey(a)];
        if (!f || badge.textContent === f.text) continue;
        changes.push({
            key: badgeKey(a),
            label: f.label,
            from: badgeCount(badge.textContent),
            to: f.count,
        });
        badge.textContent = f.text;
    }
    return changes;
}
