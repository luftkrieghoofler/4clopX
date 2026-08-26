// Adapter for overview.php — the nation's per-resource production stats.
//
// The Overview page renders a "Resources" panel whose table has columns
// Resource / Qty / Generated / Used / Loss / Net / Ticks-Worth (plus an
// optional leading icon column when the user hasn't hidden icons), where
// "Used" is the per-tick upkeep and "Net" is Generated − Used − Loss.
// Resource names come from resourcedefs.name — the same strings the
// marketplace select options use — so callers can match by name.
//
// The military's separate consumption ("Your military also uses N apples,
// N gems, N coffee, and N gasoline every 12 hours."), rendered below the
// table inside the same panel, is exposed as `mil` (0 for everything else).
// It is a 12-hour lump, NOT part of the per-tick "Used" column or "Net".
//
// Building quantities are included as `buildingsByName`, because action
// upgrades can consume active buildings and thereby remove their upkeep.
//
// Returns {
//   byName: { <lowercased name>: {name, qty, used, mil, net} },
//   buildingsByName: { <lowercased name>: {name, qty, disabled, active} },
//   at: Date,
// }.

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
                mil: 0,
                net: cellNumber(cells[cNet].textContent),
            };
        }
        for (const c of panel.querySelectorAll('center')) {
            if (!/military also uses/i.test(c.textContent)) continue;
            // "1,234 apples, 56 gems, ..." — pair numbers with the word that
            // follows; words that aren't resource names (e.g. "12 hours")
            // simply don't match anything.
            for (const m of c.textContent.matchAll(/([\d,]+)\s+([A-Za-z]+)/g)) {
                const key = m[2].toLowerCase();
                if (!byName[key]) {
                    byName[key] = {
                        name: `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}`,
                        qty: 0, used: 0, mil: 0, net: 0,
                    };
                }
                byName[key].mil = cellNumber(m[1]);
            }
        }

        const buildingsByName = {};
        for (const buildingPanel of doc.querySelectorAll('.panel')) {
            const buildingHeading = buildingPanel.querySelector('.panel-heading');
            if (!buildingHeading || buildingHeading.textContent.trim() !== 'Buildings') continue;
            for (const tr of buildingPanel.querySelectorAll('tbody tr')) {
                const cells = tr.querySelectorAll('td');
                if (cells.length < 2) continue;
                const name = cells[0].textContent.trim();
                const quantityText = cells[1].textContent;
                const qty = cellNumber(quantityText);
                const disabledMatch = quantityText.match(/([\d,]+)\s+disabled/i);
                const disabled = disabledMatch ? cellNumber(disabledMatch[1]) : 0;
                if (!name) continue;
                buildingsByName[name.toLowerCase()] = {
                    name, qty, disabled, active: Math.max(0, qty - disabled),
                };
            }
            break;
        }
        return { byName, buildingsByName, at: new Date() };
    }
    throw new Error('Could not find the Resources table on the Overview page.');
}

export async function fetchResourceStats(core) {
    return parseResourceStats(await core.http.getDoc('overview.php'));
}
