// Adapter for overview.php — the nation's per-resource production stats.
//
// The Overview page renders a "Resources" panel whose table has columns
// Resource / Qty / Generated / Used / Loss / Net / Ticks-Worth (plus an
// optional leading icon column when the user hasn't hidden icons), where
// "Used" is the per-tick upkeep and "Net" is Generated − Used − Loss.
// Resource names come from resourcedefs.name — the same strings the
// marketplace select options use — so callers can match by name.
//
// Returns { byName: { <lowercased name>: {name, qty, used, net} }, at: Date }.

function cellNumber(text) {
    const n = parseInt(text.replace(/,/g, '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
}

export function parseResourceStats(doc) {
    for (const panel of doc.querySelectorAll('.panel')) {
        const heading = panel.querySelector('.panel-heading');
        if (!heading || heading.textContent.trim() !== 'Resources') continue;
        const table = panel.querySelector('table');
        if (!table) break;
        // Resolve columns by header label so the optional icon column (an
        // empty header cell) can't shift anything.
        const headCells = [...table.querySelectorAll('thead td, thead th')].map((c) => c.textContent.trim());
        const cName = headCells.indexOf('Resource');
        const cQty = headCells.indexOf('Qty');
        const cUsed = headCells.indexOf('Used');
        const cNet = headCells.indexOf('Net');
        if (cName < 0 || cQty < 0 || cUsed < 0 || cNet < 0) break;
        const byName = {};
        for (const tr of table.querySelectorAll('tbody tr')) {
            const cells = tr.querySelectorAll('td');
            if (cells.length <= Math.max(cName, cQty, cUsed, cNet)) continue;
            const name = cells[cName].textContent.trim();
            if (!name) continue;
            byName[name.toLowerCase()] = {
                name,
                qty: cellNumber(cells[cQty].textContent),
                used: cellNumber(cells[cUsed].textContent),
                net: cellNumber(cells[cNet].textContent),
            };
        }
        return { byName, at: new Date() };
    }
    throw new Error('Could not find the Resources table on the Overview page.');
}

export async function fetchResourceStats(core) {
    return parseResourceStats(await core.http.getDoc('overview.php'));
}
