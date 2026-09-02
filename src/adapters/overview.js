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
//   byName: { <lowercased name>: {name, qty, generated, used, mil, net} },
//   buildingsByName: { <lowercased name>: {name, qty, disabled, active} },
//   satisfaction: number | null,
//   satisfactionPerTick: number | null, // displayed value, including decay
//   government: string | null,
//   at: Date,
// }.

import {
    REBEL_SATISFACTION_THRESHOLDS, satisfactionPerTickWithoutDecay,
    satisfactionTicksWorth,
} from '../lib/satisfaction-safety.js';

export const RESOURCE_STATS_CACHE_KEY = 'clopx.live.overview';

function cellNumber(text) {
    const n = parseInt(text.replace(/,/g, '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
}

export function nationStatusFromDocument(doc) {
    for (const panel of doc.querySelectorAll('.panel')) {
        const heading = panel.querySelector('.panel-heading');
        if (!heading || heading.textContent.trim() !== 'Nation') continue;
        const status = {
            government: null,
            satisfaction: null,
            satisfactionPerTick: null,
        };
        for (const tr of panel.querySelectorAll('tbody tr')) {
            const cells = tr.querySelectorAll('td');
            if (cells.length < 2) continue;
            const label = cells[0].textContent.trim();
            const value = cells[1].textContent.trim();
            if (label === 'Government Type') status.government = value;
            if (label === 'Satisfaction') {
                status.satisfaction = cellNumber(value);
                const perTick = value.match(/\(\s*([+-]?[\d,]+)\s+per tick\s*\)/i);
                if (perTick) status.satisfactionPerTick = cellNumber(perTick[1]);
            }
        }
        return status;
    }
    return { government: null, satisfaction: null, satisfactionPerTick: null };
}

export function nationSatisfactionFromDocument(doc) {
    return nationStatusFromDocument(doc).satisfaction;
}

export function overviewSatisfactionRow(doc) {
    for (const panel of doc.querySelectorAll('.panel')) {
        const heading = panel.querySelector('.panel-heading');
        if (!heading || heading.textContent.trim() !== 'Nation') continue;
        for (const row of panel.querySelectorAll('tbody tr')) {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2 && cells[0].textContent.trim() === 'Satisfaction') {
                return { row, labelCell: cells[0], valueCell: cells[1] };
            }
        }
        return null;
    }
    return null;
}

function resourceTableInfo(doc) {
    for (const panel of doc.querySelectorAll('.panel')) {
        const heading = panel.querySelector('.panel-heading');
        if (!heading || heading.textContent.trim() !== 'Resources') continue;
        const table = panel.querySelector('table');
        if (!table) return null;
        const headers = [...table.querySelectorAll('thead td, thead th')]
            .map((cell) => cell.textContent.trim());
        const columns = {
            name: headers.indexOf('Resource'),
            qty: headers.indexOf('Qty'),
            generated: headers.indexOf('Generated'),
            used: headers.indexOf('Used'),
            net: headers.indexOf('Net'),
        };
        if (Object.values(columns).some((column) => column < 0)) return null;
        return { panel, table, headers, columns };
    }
    return null;
}

// The live Overview UI uses this to attach status badges without assuming
// whether the optional icon column is present.
export function overviewResourceRows(doc) {
    const info = resourceTableInfo(doc);
    if (!info) return [];
    const iconColumn = info.columns.name > 0 && info.headers[info.columns.name - 1] === ''
        ? info.columns.name - 1
        : -1;
    const rows = [];
    for (const row of info.table.querySelectorAll('tbody tr')) {
        const cells = row.querySelectorAll('td');
        const nameCell = cells[info.columns.name];
        if (!nameCell) continue;
        const name = nameCell.textContent.trim();
        if (!name) continue;
        rows.push({
            name,
            row,
            nameCell,
            iconCell: iconColumn >= 0 ? cells[iconColumn] || null : null,
        });
    }
    return rows;
}

export function parseResourceStats(doc) {
    const info = resourceTableInfo(doc);
    if (info) {
        const { panel, table, columns } = info;
        const cName = columns.name;
        const cQty = columns.qty;
        const cGenerated = columns.generated;
        const cUsed = columns.used;
        const cNet = columns.net;
        const byName = {};
        for (const tr of table.querySelectorAll('tbody tr')) {
            const cells = tr.querySelectorAll('td');
            if (cells.length <= Math.max(cName, cQty, cGenerated, cUsed, cNet)) continue;
            const name = cells[cName].textContent.trim();
            if (!name) continue;
            byName[name.toLowerCase()] = {
                name,
                qty: cellNumber(cells[cQty].textContent),
                generated: cellNumber(cells[cGenerated].textContent),
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
                        qty: 0, generated: 0, used: 0, mil: 0, net: 0,
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
        const nation = nationStatusFromDocument(doc);
        return {
            byName,
            buildingsByName,
            ...nation,
            at: new Date(),
        };
    }
    throw new Error('Could not find the Resources table on the Overview page.');
}

function snapshotResourceStats(stats, at = Date.now()) {
    const byName = {};
    for (const [key, resource] of Object.entries(stats && stats.byName || {})) {
        if (!resource || !resource.name) continue;
        byName[key] = {
            name: String(resource.name),
            qty: Number(resource.qty) || 0,
            generated: Number(resource.generated) || 0,
            used: Number(resource.used) || 0,
            mil: Number(resource.mil) || 0,
            net: Number(resource.net) || 0,
        };
    }
    const statusNumber = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    };
    return {
        at: Number(at) || Date.now(),
        byName,
        satisfaction: statusNumber(stats && stats.satisfaction),
        satisfactionPerTick: statusNumber(stats && stats.satisfactionPerTick),
        government: stats && stats.government ? String(stats.government) : null,
    };
}

export function readCachedResourceStats() {
    try {
        const record = JSON.parse(localStorage.getItem(RESOURCE_STATS_CACHE_KEY) || 'null');
        if (!record || typeof record !== 'object' || !record.byName) return null;
        return snapshotResourceStats(record, record.at);
    } catch (e) {
        return null;
    }
}

// Publish the resource and satisfaction values needed by global badges.
// Safety checks still use their freshly parsed full result (including
// buildings), while every such fetch updates this cross-tab cache for free.
export function publishResourceStats(core, stats, at = Date.now()) {
    const snapshot = snapshotResourceStats(stats, at);
    try { localStorage.setItem(RESOURCE_STATS_CACHE_KEY, JSON.stringify(snapshot)); } catch (e) { /* ignore */ }
    if (core && core.events) core.events.emit('overview:resourceStats', { stats: snapshot });
    return snapshot;
}

// The stock column subtracts one upcoming consumption before dividing the
// remaining buffer by the ongoing deficit. It therefore displays zero for a
// resource which can run exactly once more; add that omitted tick back.
export function resourceTicksWorth(resource) {
    if (!resource) return null;
    const qty = Number(resource.qty);
    const used = Number(resource.used);
    const net = Number(resource.net);
    if (![qty, used, net].every(Number.isFinite) || net >= 0) return null;
    if (qty < used) return 0;
    return Math.max(0, Math.floor((qty - used) / Math.abs(net)) + 1);
}

const tickThreshold = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
};

export function resourceBufferSummary(stats, warningTicks = 5, criticalTicks = 1) {
    const warningThreshold = tickThreshold(warningTicks, 5);
    const criticalThreshold = tickThreshold(criticalTicks, 1);
    const warning = [];
    const critical = [];
    for (const resource of Object.values(stats && stats.byName || {})) {
        const ticks = resourceTicksWorth(resource);
        if (ticks === null) continue;
        const item = { name: resource.name, ticks };
        if (ticks <= criticalThreshold) critical.push(item);
        else if (ticks <= warningThreshold) warning.push(item);
    }
    const compare = (a, b) => a.ticks - b.ticks || a.name.localeCompare(b.name);
    warning.sort(compare);
    critical.sort(compare);
    const satisfactionTicks = satisfactionTicksWorth(stats);
    let satisfaction = null;
    if (satisfactionTicks !== null
        && (satisfactionTicks <= warningThreshold || satisfactionTicks <= criticalThreshold)) {
        const perTick = satisfactionPerTickWithoutDecay(stats);
        satisfaction = {
            name: 'Satisfaction',
            ticks: satisfactionTicks,
            severity: satisfactionTicks <= criticalThreshold ? 'critical' : 'warning',
            value: Number(stats.satisfaction),
            perTick,
            displayedPerTick: Number(stats.satisfactionPerTick),
            rebelThreshold: REBEL_SATISFACTION_THRESHOLDS[stats.government],
        };
    }
    const warningCount = warning.length + Number(satisfaction && satisfaction.severity === 'warning');
    const criticalCount = critical.length + Number(satisfaction && satisfaction.severity === 'critical');
    return {
        warningThreshold,
        criticalThreshold,
        warning,
        critical,
        affected: [...critical, ...warning],
        satisfaction,
        warningCount,
        criticalCount,
        affectedCount: warningCount + criticalCount,
    };
}

export function newlyCriticalResources(previous, current, warningTicks = 5, criticalTicks = 1) {
    if (!previous) return [];
    const before = new Set(resourceBufferSummary(
        previous, warningTicks, criticalTicks).critical.map((item) => item.name.toLowerCase()));
    return resourceBufferSummary(current, warningTicks, criticalTicks).critical
        .filter((item) => !before.has(item.name.toLowerCase()));
}

export function newlyCriticalOverviewBuffers(
    previous, current, warningTicks = 5, criticalTicks = 1,
) {
    if (!previous) return { resources: [], satisfaction: null };
    const resources = newlyCriticalResources(
        previous, current, warningTicks, criticalTicks);
    const before = resourceBufferSummary(previous, warningTicks, criticalTicks);
    const after = resourceBufferSummary(current, warningTicks, criticalTicks);
    const previousSatisfactionKnown = previous.satisfaction !== null
        && previous.satisfaction !== undefined
        && previous.satisfactionPerTick !== null
        && previous.satisfactionPerTick !== undefined
        && Number.isFinite(REBEL_SATISFACTION_THRESHOLDS[previous.government]);
    const satisfaction = previousSatisfactionKnown
        && after.satisfaction && after.satisfaction.severity === 'critical'
        && (!before.satisfaction || before.satisfaction.severity !== 'critical')
        ? after.satisfaction
        : null;
    return { resources, satisfaction };
}

export async function fetchResourceStats(core) {
    const stats = parseResourceStats(await core.http.getDoc('overview.php'));
    publishResourceStats(core, stats);
    return stats;
}
