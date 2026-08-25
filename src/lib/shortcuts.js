// Persistent navigation shortcuts.  Ordinary pages store a canonical,
// same-origin path; marketplace views store their semantic identity because
// selecting a resource is a POST-backed operation rather than a stock URL.

import { marketViewUrl } from '../adapters/market.js';

export const SHORTCUTS_STORAGE_KEY = 'clopx.shortcuts.items';
export const SHORTCUTS_ONBOARDING_KEY = 'clopx.shortcuts.onboardingDismissed';

const MODES = ['', 'weapons', 'armor'];
const SIDES = ['sell', 'buyer'];

function storageOrigin(origin) {
    if (origin) return origin;
    if (typeof location !== 'undefined' && location.origin) return location.origin;
    return 'https://4clop.invalid';
}

// A path-only representation keeps shortcuts valid on either supported CLOP
// hostname and prevents the editor from becoming a way to add external links.
export function pageShortcutTarget(urlLike, origin) {
    try {
        const base = new URL(storageOrigin(origin));
        const url = new URL(urlLike, `${base.origin}/`);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin) return null;
        url.searchParams.sort();
        return { kind: 'page', href: `${url.pathname}${url.search}${url.hash}` };
    } catch (e) {
        return null;
    }
}

export function marketShortcutTarget(side, mode, resourceId, resourceName = '') {
    const id = String(resourceId || '');
    const normalizedMode = String(mode || '');
    if (!SIDES.includes(side) || !MODES.includes(normalizedMode) || !id) return null;
    return {
        kind: 'market',
        side,
        mode: normalizedMode,
        resourceId: id,
        resourceName: String(resourceName || ''),
    };
}

function normalizeTarget(target, origin) {
    if (!target || typeof target !== 'object') return null;
    if (target.kind === 'page') return pageShortcutTarget(target.href, origin);
    if (target.kind === 'market') {
        return marketShortcutTarget(target.side, target.mode, target.resourceId, target.resourceName);
    }
    return null;
}

export function shortcutIdentity(target) {
    if (!target) return '';
    if (target.kind === 'page') return `page:${target.href}`;
    if (target.kind === 'market') {
        return `market:${target.side}:${target.mode || 'resources'}:${target.resourceId}`;
    }
    return '';
}

export function shortcutHref(target) {
    if (!target) return '#';
    if (target.kind === 'page') return target.href;
    if (target.kind === 'market') return marketViewUrl(target.side, target.mode, target.resourceId);
    return '#';
}

export function newShortcut(label, target, id = '') {
    const normalized = normalizeTarget(target);
    if (!normalized) return null;
    const generatedId = id || (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    return {
        id: String(generatedId),
        label: String(label || '').trim() || 'Shortcut',
        target: normalized,
    };
}

function normalizeShortcut(item, origin) {
    if (!item || typeof item !== 'object' || !item.id) return null;
    const target = normalizeTarget(item.target, origin);
    if (!target) return null;
    return {
        id: String(item.id),
        label: String(item.label || '').trim() || 'Shortcut',
        target,
    };
}

export function readShortcuts(origin) {
    try {
        const raw = JSON.parse(localStorage.getItem(SHORTCUTS_STORAGE_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        const identities = new Set();
        const ids = new Set();
        const out = [];
        for (const item of raw) {
            const normalized = normalizeShortcut(item, origin);
            if (!normalized) continue;
            const identity = shortcutIdentity(normalized.target);
            if (ids.has(normalized.id) || identities.has(identity)) continue;
            ids.add(normalized.id);
            identities.add(identity);
            out.push(normalized);
        }
        return out;
    } catch (e) {
        return [];
    }
}

export function writeShortcuts(items, origin) {
    const identities = new Set();
    const ids = new Set();
    const normalized = [];
    for (const item of items || []) {
        const value = normalizeShortcut(item, origin);
        if (!value) continue;
        const identity = shortcutIdentity(value.target);
        if (ids.has(value.id) || identities.has(identity)) continue;
        ids.add(value.id);
        identities.add(identity);
        normalized.push(value);
    }
    try { localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(normalized)); } catch (e) { /* ignore */ }
    return normalized;
}

export function shortcutStorageChange(storageKey) {
    if (storageKey === SHORTCUTS_STORAGE_KEY) return 'items';
    if (storageKey === SHORTCUTS_ONBOARDING_KEY) return 'onboarding';
    return null;
}

export function shortcutOnboardingDismissed() {
    try { return localStorage.getItem(SHORTCUTS_ONBOARDING_KEY) === '1'; } catch (e) { return false; }
}

export function dismissShortcutOnboarding() {
    try { localStorage.setItem(SHORTCUTS_ONBOARDING_KEY, '1'); } catch (e) { /* ignore */ }
}
