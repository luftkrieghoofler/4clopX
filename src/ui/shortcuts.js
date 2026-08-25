// Global shortcut bar.  One browser-style save control captures the current
// view; editing stays in a dedicated manager instead of adding permanent
// controls to every stock menu entry.

import { isLoggedInDoc } from '../adapters/session.js';
import {
    kindFromLocation, marketResourceFromLocation,
} from '../adapters/market.js';
import { readMarketCatalog } from '../lib/favourites.js';
import {
    dismissShortcutOnboarding, marketShortcutTarget, newShortcut,
    pageShortcutTarget, readShortcuts, shortcutHref, shortcutIdentity,
    shortcutOnboardingDismissed, shortcutStorageChange, writeShortcuts,
} from '../lib/shortcuts.js';
import { readFriendlyCache } from './liveupdates.js';

const MODE_LABELS = { '': 'Resources', weapons: 'Weapons', armor: 'Armor' };
const SIDE_LABELS = { sell: 'Sell Orders', buyer: 'Buy Orders' };
const isMarketPath = (pathname) => /\/(?:buyer)?marketplace\.php$/i.test(pathname);

function cleanAnchorLabel(anchor) {
    const clone = anchor.cloneNode(true);
    for (const node of clone.querySelectorAll('.badge, .caret, .sr-only')) node.remove();
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

// Read the stock navbar once, before userscript controls are inserted.  The
// manager therefore follows server menu changes without maintaining a second
// hard-coded sitemap.
export function stockMenuDestinations(doc, origin) {
    const nav = doc.querySelector('nav.navbar');
    if (!nav) return [];
    const groups = [];
    const byGroup = new Map();
    const seen = new Set();

    const add = (group, anchor) => {
        const raw = anchor.getAttribute('href') || '';
        if (!raw || raw === '#' || /^javascript:/i.test(raw)) return;
        const target = pageShortcutTarget(anchor.href || raw, origin);
        if (!target || /\/logout\.php$/i.test(new URL(target.href, origin).pathname)) return;
        const identity = shortcutIdentity(target);
        const label = cleanAnchorLabel(anchor);
        if (!label || seen.has(identity)) return;
        seen.add(identity);
        if (!byGroup.has(group)) {
            const record = { label: group, entries: [] };
            byGroup.set(group, record);
            groups.push(record);
        }
        byGroup.get(group).entries.push({ label, target });
    };

    // This runs before our timer/settings/save controls are injected, so the
    // stock right-hand group is useful catalogue data too (for example a
    // direct Messages or profile entry).  Logout is filtered in add().
    const lists = [...nav.querySelectorAll('ul.navbar-nav')];
    for (const list of lists) {
        for (const li of [...list.children]) {
            const top = li.querySelector(':scope > a');
            const submenu = li.querySelector(':scope > ul.dropdown-menu');
            if (submenu) {
                const group = top ? cleanAnchorLabel(top) || 'Navigation' : 'Navigation';
                for (const anchor of submenu.querySelectorAll('a[href]')) add(group, anchor);
            } else if (top) {
                add('Main', top);
            }
        }
    }
    return groups.filter((group) => group.entries.length);
}

export const shortcutsModule = {
    name: 'shortcuts',

    matches: () => true,

    settings(core) {
        core.settings.define({
            key: 'shortcuts.visible',
            section: 'Shortcuts',
            label: 'Show the shortcut bar',
            description: 'Display saved destinations in a sticky row below the stock navigation bar.',
            type: 'bool',
            default: true,
            onChange: () => core.events.emit('shortcuts:changed', {}),
        });
        core.settings.define({
            key: 'shortcuts.manage',
            section: 'Shortcuts',
            label: 'Manage shortcuts…',
            description: 'Rename, reorder, remove, or add several destinations from the stock game menu.',
            type: 'button',
            feedback: false,
            handler: () => core.events.emit('shortcuts:openManager', {}),
        });
    },

    init(core) {
        if (!isLoggedInDoc(document)) return;
        const nav = document.querySelector('nav.navbar');
        const navRight = nav && nav.querySelector('ul.navbar-right');
        if (!nav || !navRight) return;

        const el = core.el.bind(core);
        const origin = location.origin;
        const menuGroups = stockMenuDestinations(document, origin);
        const menuEntries = menuGroups.flatMap((group) => group.entries);
        let marketView = null;
        let popover = null;
        let popoverOutside = null;
        let manager = null;

        core.addStyle(`
            nav.navbar.clop-shortcuts-visible { margin-bottom: 0; }
            #clop-shortcut-bar { position: sticky; top: 0; z-index: 990; margin-bottom: 20px; background: #f8f8f8; border-bottom: 1px solid #e7e7e7; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
            #clop-shortcut-bar .clop-shortcut-row { min-height: 35px; display: flex; align-items: stretch; }
            #clop-shortcut-bar .clop-shortcut-links { display: flex; align-items: stretch; min-width: 0; overflow-x: auto; overflow-y: hidden; flex: 1; }
            #clop-shortcut-bar .clop-shortcut-link { display: flex; align-items: center; flex: 0 0 auto; padding: 7px 10px; color: #555; white-space: nowrap; text-decoration: none; border-right: 1px solid rgba(0,0,0,.07); }
            #clop-shortcut-bar .clop-shortcut-link:hover { color: #222; background: #eee; }
            #clop-shortcut-bar .clop-shortcut-link.active { color: #fff; background: #5bc0de; text-shadow: none; }
            #clop-shortcut-bar .clop-shortcut-link.active .clop-unavailable-market-badge { color: rgba(255,255,255,.85) !important; border-color: rgba(255,255,255,.75); }
            #clop-shortcut-bar .badge { margin-left: 5px; }
            #clop-shortcut-bar .clop-shortcut-empty { display: flex; align-items: center; min-height: 35px; width: 100%; color: #777; }
            #clop-shortcut-bar .clop-shortcut-empty-message { flex: 1; text-align: center; }
            #clop-shortcut-bar .clop-shortcut-empty-message .btn-link { padding: 0; color: #337ab7; vertical-align: baseline; }
            #clop-shortcut-bar .clop-shortcut-dismiss { flex: 0 0 auto; margin: 5px 0; }
            .clop-save-shortcut > a { cursor: pointer; font-size: 16px; }
            .clop-save-shortcut.active > a { color: #f0ad4e !important; }
            .clop-shortcut-popover { position: fixed; z-index: 10020; width: 310px; max-width: calc(100vw - 20px); padding: 12px; background: #fff; border: 1px solid #ccc; border-radius: 4px; box-shadow: 0 5px 15px rgba(0,0,0,.25); }
            .clop-shortcut-popover h4 { margin: 0 0 9px; font-size: 15px; }
            .clop-shortcut-popover .form-control { margin-bottom: 9px; }
            .clop-shortcut-popover-actions { display: flex; align-items: center; gap: 6px; }
            .clop-shortcut-popover-actions .clop-spacer { flex: 1; }
            .clop-shortcut-manager-overlay { position: fixed; inset: 0; z-index: 10030; padding-top: 55px; display: flex; align-items: flex-start; justify-content: center; background: rgba(0,0,0,.55); }
            .clop-shortcut-manager { width: 680px; max-width: 94vw; }
            .clop-shortcut-manager .panel-body { max-height: 75vh; overflow-y: auto; }
            .clop-shortcut-manager .panel-heading .close { line-height: 1; }
            .clop-shortcut-manager-toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
            .clop-shortcut-manager-list { margin-bottom: 12px; }
            .clop-shortcut-manager-item { display: grid; grid-template-columns: 24px minmax(150px, 1fr) auto; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid #eee; }
            .clop-shortcut-manager-item.clop-drag-over { border-top: 2px solid #5bc0de; }
            .clop-shortcut-drag { cursor: grab; color: #999; text-align: center; font-size: 18px; user-select: none; }
            .clop-shortcut-item-target { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .clop-shortcut-item-actions { white-space: nowrap; }
            .clop-shortcut-item-actions .btn { margin-left: 3px; }
            .clop-shortcut-menu-picker { border-top: 1px solid #ddd; padding-top: 12px; }
            .clop-shortcut-menu-search { max-width: 280px; margin-bottom: 10px; }
            .clop-shortcut-menu-group { margin: 12px 0 4px; font-weight: bold; }
            .clop-shortcut-menu-entry { display: flex; align-items: center; min-height: 31px; padding: 3px 0 3px 10px; border-bottom: 1px solid #f2f2f2; }
            .clop-shortcut-menu-entry span { flex: 1; }
            @media (max-width: 600px) {
                .clop-shortcut-manager-item { grid-template-columns: 20px minmax(100px, 1fr); }
                .clop-shortcut-item-actions { grid-column: 2; }
            }
        `);

        const navContainer = nav.querySelector(':scope > .container-fluid') ? 'container-fluid' : 'container';
        const barRow = el('div', { class: 'clop-shortcut-row' });
        const bar = el('div', { id: 'clop-shortcut-bar', style: 'display:none;' }, [
            el('div', { class: navContainer }, [barRow]),
        ]);
        nav.insertAdjacentElement('afterend', bar);

        const saveAnchor = el('a', {
            href: '#',
            title: 'Save this view to the shortcut bar',
            'aria-label': 'Save this view to the shortcut bar',
            'aria-pressed': 'false',
            onclick: (ev) => {
                ev.preventDefault();
                saveCurrentView();
            },
        }, ['🔖']);
        const saveLi = el('li', { class: 'clop-save-shortcut' }, [saveAnchor]);
        navRight.insertBefore(saveLi, navRight.firstElementChild);

        function items() {
            return readShortcuts(origin);
        }

        function commit(next) {
            writeShortcuts(next, origin);
            core.events.emit('shortcuts:changed', {});
        }

        function dismissOnboarding() {
            dismissShortcutOnboarding();
            core.events.emit('shortcuts:changed', {});
        }

        function currentMarketTarget() {
            if (!isMarketPath(location.pathname)) return null;
            const side = kindFromLocation(location);
            const mode = new URLSearchParams(location.search).get('mode') || '';
            const resourceId = (marketView && marketView.side === side && marketView.mode === mode
                ? marketView.resourceId
                : null) || marketResourceFromLocation(location);
            if (!resourceId) return null;
            const known = readMarketCatalog(mode).find((resource) => resource.id === String(resourceId));
            const name = marketView && marketView.resourceId === String(resourceId)
                ? marketView.resourceName
                : known && known.name;
            return marketShortcutTarget(side, mode, resourceId, name || `resource ${resourceId}`);
        }

        function currentPageTarget(stripMarketFragment = false) {
            const url = new URL(location.href);
            if (stripMarketFragment && isMarketPath(url.pathname)
                && marketResourceFromLocation(url)) url.hash = '';
            return pageShortcutTarget(url.href, origin);
        }

        function inferredPageLabel(target) {
            const identity = shortcutIdentity(target);
            const menu = menuEntries.find((entry) => shortcutIdentity(entry.target) === identity);
            if (menu) return menu.label;
            const heading = document.querySelector('#content h1, #content h2, #content h3, #content .page-header');
            const headingText = heading && (heading.textContent || '').replace(/\s+/g, ' ').trim();
            if (headingText) return headingText.slice(0, 80);
            const title = String(document.title || '')
                .replace(/^(?:\[[^\]]+\]\s*)?(?:\(Mkt:[^)]+\)\s*)?/, '')
                .replace(/\s*[-|–]\s*>?CLOP.*$/i, '')
                .trim();
            return (title || target.href.replace(/^\//, '') || 'Shortcut').slice(0, 80);
        }

        function captureCurrent() {
            const market = currentMarketTarget();
            if (market) {
                return {
                    target: market,
                    label: `${market.resourceName} — ${SIDE_LABELS[market.side]}`,
                };
            }
            const target = currentPageTarget();
            return target ? { target, label: inferredPageLabel(target) } : null;
        }

        function currentSavedItem() {
            const capture = captureCurrent();
            if (!capture) return null;
            const identity = shortcutIdentity(capture.target);
            return items().find((item) => shortcutIdentity(item.target) === identity) || null;
        }

        function isCurrent(target) {
            if (target.kind === 'market') {
                const market = currentMarketTarget();
                return !!market && shortcutIdentity(market) === shortcutIdentity(target);
            }
            const page = currentPageTarget(true);
            return !!page && shortcutIdentity(page) === shortcutIdentity(target);
        }

        function menuBadges(target) {
            const identity = shortcutIdentity(target);
            for (const anchor of nav.querySelectorAll('a[href]')) {
                const raw = anchor.getAttribute('href') || '';
                if (!raw || raw === '#' || /^javascript:/i.test(raw)) continue;
                const candidate = pageShortcutTarget(anchor.href, origin);
                if (!candidate || shortcutIdentity(candidate) !== identity) continue;
                return [...anchor.querySelectorAll(':scope > .badge')].map((badge) => badge.cloneNode(true));
            }
            return [];
        }

        function marketBadges(target) {
            const key = `${target.mode || 'resources'}|${target.side}|${target.resourceId}`;
            const value = readFriendlyCache()[key];
            if (!value) return [];
            const badges = [];
            const what = target.side === 'sell' ? 'selling' : 'buying';
            if (value.count) {
                badges.push(el('span', {
                    class: 'badge clop-menu-badge clop-actionable-market-badge',
                    title: `${value.count} actionable alliance/friend order${value.count === 1 ? '' : 's'} ${what} ${core.commas(value.amount)} total`,
                }, [String(value.count)]));
            }
            if (value.unavailableCount) {
                badges.push(el('span', {
                    class: 'badge clop-menu-badge clop-unavailable-market-badge',
                    title: `${value.unavailableCount} alliance/friend order${value.unavailableCount === 1 ? '' : 's'} unavailable because you have no stock above upkeep`,
                }, [String(value.unavailableCount)]));
            }
            return badges;
        }

        function renderBar() {
            const saved = items();
            const visible = core.settings.get('shortcuts.visible')
                && (saved.length > 0 || !shortcutOnboardingDismissed());
            bar.style.display = visible ? '' : 'none';
            nav.classList.toggle('clop-shortcuts-visible', visible);
            if (!visible) return;

            const oldScroll = barRow.querySelector('.clop-shortcut-links')?.scrollLeft || 0;
            barRow.textContent = '';
            if (!saved.length) {
                const action = el('button', {
                    class: 'btn btn-link btn-xs',
                    type: 'button',
                    onclick: saveCurrentView,
                }, ['click 🔖 in the main navigation to save this page']);
                barRow.appendChild(el('div', { class: 'clop-shortcut-empty' }, [
                    el('div', { class: 'clop-shortcut-empty-message' }, [
                        'No shortcuts yet — ', action, '.',
                    ]),
                    el('button', {
                        class: 'close clop-shortcut-dismiss',
                        type: 'button',
                        title: 'Dismiss this shortcut-bar introduction',
                        'aria-label': 'Dismiss this shortcut-bar introduction',
                        onclick: dismissOnboarding,
                    }, ['×']),
                ]));
                return;
            }

            const links = el('div', { class: 'clop-shortcut-links' });
            for (const item of saved) {
                const anchor = el('a', {
                    class: `clop-shortcut-link${isCurrent(item.target) ? ' active' : ''}`,
                    href: shortcutHref(item.target),
                    title: item.label,
                }, [item.label]);
                const badges = item.target.kind === 'market'
                    ? marketBadges(item.target)
                    : menuBadges(item.target);
                for (const badge of badges) anchor.appendChild(badge);
                links.appendChild(anchor);
            }
            barRow.appendChild(links);
            links.scrollLeft = oldScroll;
        }

        function refreshSaveButton() {
            const saved = !!currentSavedItem();
            saveLi.classList.toggle('active', saved);
            saveAnchor.setAttribute('aria-pressed', saved ? 'true' : 'false');
            saveAnchor.title = saved
                ? 'Edit or remove this saved shortcut'
                : 'Save this view to the shortcut bar';
        }

        function closePopover() {
            if (!popover) return;
            popover.remove();
            popover = null;
            if (popoverOutside) document.removeEventListener('mousedown', popoverOutside, true);
            popoverOutside = null;
        }

        function updateLabel(id, label) {
            const trimmed = String(label || '').trim();
            if (!trimmed) return;
            commit(items().map((item) => item.id === id ? { ...item, label: trimmed } : item));
        }

        function openPopover(id, newlyAdded) {
            closePopover();
            const item = items().find((candidate) => candidate.id === id);
            if (!item) return;
            const input = el('input', {
                class: 'form-control input-sm',
                type: 'text',
                value: item.label,
                'data-shortcut-id': id,
                'aria-label': 'Shortcut label',
            });
            input.value = item.label;
            input.addEventListener('change', () => {
                if (input.value.trim()) updateLabel(id, input.value);
                else input.value = items().find((candidate) => candidate.id === id)?.label || item.label;
            });
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { input.blur(); closePopover(); }
                if (ev.key === 'Escape') closePopover();
            });
            popover = el('div', { class: 'clop-shortcut-popover' }, [
                el('h4', {}, [newlyAdded ? 'Shortcut saved' : 'Saved shortcut']),
                input,
                el('div', { class: 'clop-shortcut-popover-actions' }, [
                    el('button', {
                        class: 'btn btn-danger btn-xs', type: 'button',
                        onclick: () => {
                            commit(items().filter((candidate) => candidate.id !== id));
                            closePopover();
                        },
                    }, ['Remove']),
                    el('span', { class: 'clop-spacer' }),
                    el('button', {
                        class: 'btn btn-default btn-xs', type: 'button',
                        onclick: () => { closePopover(); openManager(); },
                    }, ['Manage all…']),
                    el('button', {
                        class: 'btn btn-primary btn-xs', type: 'button', onclick: closePopover,
                    }, ['Done']),
                ]),
            ]);
            document.body.appendChild(popover);
            const rect = saveAnchor.getBoundingClientRect();
            popover.style.top = `${Math.max(10, Math.min(window.innerHeight - popover.offsetHeight - 10, rect.bottom + 6))}px`;
            popover.style.right = `${Math.max(10, window.innerWidth - rect.right)}px`;
            setTimeout(() => {
                popoverOutside = (ev) => {
                    if (popover && !popover.contains(ev.target) && !saveAnchor.contains(ev.target)) closePopover();
                };
                document.addEventListener('mousedown', popoverOutside, true);
                if (newlyAdded) { input.focus(); input.select(); }
            }, 0);
        }

        function saveCurrentView(openEditor = true) {
            const capture = captureCurrent();
            if (!capture) return;
            const identity = shortcutIdentity(capture.target);
            let item = items().find((candidate) => shortcutIdentity(candidate.target) === identity);
            let newlyAdded = false;
            if (!item) {
                item = newShortcut(capture.label, capture.target);
                if (!item) return;
                commit([...items(), item]);
                dismissShortcutOnboarding();
                newlyAdded = true;
            }
            if (openEditor) openPopover(item.id, newlyAdded);
        }

        function targetDescription(target) {
            if (target.kind === 'page') return target.href;
            return `${MODE_LABELS[target.mode]} · ${SIDE_LABELS[target.side]} · ${target.resourceName}`;
        }

        function closeManager() {
            if (!manager) return;
            document.removeEventListener('keydown', manager.onKey);
            manager.overlay.remove();
            manager = null;
        }

        function openManager() {
            if (manager) return;
            core.events.emit('settings:close', {});
            closePopover();

            const savedBox = el('div', { class: 'clop-shortcut-manager-list' });
            const menuBox = el('div');
            const menuSearch = el('input', {
                class: 'form-control input-sm clop-shortcut-menu-search',
                type: 'search',
                placeholder: 'Filter menu destinations…',
                'aria-label': 'Filter menu destinations',
            });
            const menuPicker = el('div', {
                class: 'clop-shortcut-menu-picker',
                style: 'display:none;',
            }, [menuSearch, menuBox]);
            const menuToggle = el('button', {
                class: 'btn btn-default btn-sm', type: 'button',
            }, ['Add from game menu…']);
            const addCurrent = el('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => saveCurrentView(false),
            }, ['Add current view']);
            const body = el('div', { class: 'panel-body' }, [
                el('p', { class: 'text-muted' }, [
                    'Shortcuts are real links: drag or use the arrow buttons to reorder them, and edit their visible labels here.',
                ]),
                el('div', { class: 'clop-shortcut-manager-toolbar' }, [addCurrent, menuToggle]),
                savedBox,
                menuPicker,
            ]);
            const overlay = el('div', {
                class: 'clop-shortcut-manager-overlay',
                onclick: (ev) => { if (ev.target === overlay) closeManager(); },
            }, [
                el('div', { class: 'panel panel-default clop-shortcut-manager' }, [
                    el('div', { class: 'panel-heading' }, [
                        el('button', { class: 'close', type: 'button', html: '&times;', onclick: closeManager }),
                        'Manage shortcuts',
                    ]),
                    body,
                ]),
            ]);
            const onKey = (ev) => { if (ev.key === 'Escape') closeManager(); };
            manager = { overlay, onKey, savedBox, menuBox, menuSearch, menuPicker, menuToggle, addCurrent };

            menuToggle.addEventListener('click', () => {
                const opening = menuPicker.style.display === 'none';
                menuPicker.style.display = opening ? '' : 'none';
                menuToggle.textContent = opening ? 'Hide game menu' : 'Add from game menu…';
                if (opening) { renderMenuPicker(); menuSearch.focus(); }
            });
            menuSearch.addEventListener('input', renderMenuPicker);
            document.body.appendChild(overlay);
            document.addEventListener('keydown', onKey);
            renderManagerSaved();
            renderMenuPicker();
        }

        function moveShortcut(id, delta) {
            const saved = items();
            const from = saved.findIndex((item) => item.id === id);
            const to = Math.max(0, Math.min(saved.length - 1, from + delta));
            if (from < 0 || from === to) return;
            const [moving] = saved.splice(from, 1);
            saved.splice(to, 0, moving);
            commit(saved);
        }

        function renderManagerSaved() {
            if (!manager) return;
            const saved = items();
            manager.savedBox.textContent = '';
            const current = captureCurrent();
            const currentIdentity = current ? shortcutIdentity(current.target) : '';
            manager.addCurrent.disabled = saved.some((item) => shortcutIdentity(item.target) === currentIdentity);
            manager.addCurrent.textContent = manager.addCurrent.disabled ? 'Current view added' : 'Add current view';
            if (!saved.length) {
                manager.savedBox.appendChild(el('p', { class: 'text-muted' }, ['No shortcuts saved yet.']));
                return;
            }

            let draggedId = null;
            for (const [index, item] of saved.entries()) {
                const handle = el('span', {
                    class: 'clop-shortcut-drag',
                    draggable: 'true',
                    title: 'Drag to reorder',
                    'aria-label': `Drag ${item.label} to reorder`,
                }, ['≡']);
                const input = el('input', {
                    class: 'form-control input-sm', type: 'text', value: item.label,
                    'aria-label': `Label for ${item.label}`,
                });
                input.value = item.label;
                input.addEventListener('change', () => {
                    if (input.value.trim()) updateLabel(item.id, input.value);
                    else input.value = item.label;
                });
                const row = el('div', { class: 'clop-shortcut-manager-item' }, [
                    handle,
                    el('div', {}, [input, el('small', {
                        class: 'text-muted clop-shortcut-item-target', title: targetDescription(item.target),
                    }, [targetDescription(item.target)])]),
                    el('div', { class: 'clop-shortcut-item-actions' }, [
                        (() => {
                            const button = el('button', {
                                class: 'btn btn-default btn-xs', type: 'button', title: 'Move up',
                                onclick: () => moveShortcut(item.id, -1),
                            }, ['↑']);
                            button.disabled = index === 0;
                            return button;
                        })(),
                        (() => {
                            const button = el('button', {
                                class: 'btn btn-default btn-xs', type: 'button', title: 'Move down',
                                onclick: () => moveShortcut(item.id, 1),
                            }, ['↓']);
                            button.disabled = index === saved.length - 1;
                            return button;
                        })(),
                        el('button', {
                            class: 'btn btn-danger btn-xs', type: 'button', title: 'Remove shortcut',
                            onclick: () => commit(items().filter((candidate) => candidate.id !== item.id)),
                        }, ['×']),
                    ]),
                ]);
                handle.addEventListener('dragstart', (ev) => {
                    draggedId = item.id;
                    ev.dataTransfer.effectAllowed = 'move';
                    ev.dataTransfer.setData('text/plain', item.id);
                });
                row.addEventListener('dragover', (ev) => {
                    if (!draggedId || draggedId === item.id) return;
                    ev.preventDefault();
                    row.classList.add('clop-drag-over');
                });
                row.addEventListener('dragleave', () => row.classList.remove('clop-drag-over'));
                row.addEventListener('drop', (ev) => {
                    ev.preventDefault();
                    row.classList.remove('clop-drag-over');
                    const movingId = draggedId || ev.dataTransfer.getData('text/plain');
                    const ordered = items();
                    const from = ordered.findIndex((candidate) => candidate.id === movingId);
                    const to = ordered.findIndex((candidate) => candidate.id === item.id);
                    if (from < 0 || to < 0 || from === to) return;
                    const [moving] = ordered.splice(from, 1);
                    const insertion = ordered.findIndex((candidate) => candidate.id === item.id);
                    ordered.splice(insertion, 0, moving);
                    commit(ordered);
                });
                handle.addEventListener('dragend', () => { draggedId = null; });
                manager.savedBox.appendChild(row);
            }
        }

        function renderMenuPicker() {
            if (!manager) return;
            const query = manager.menuSearch.value.trim().toLowerCase();
            const saved = new Set(items().map((item) => shortcutIdentity(item.target)));
            manager.menuBox.textContent = '';
            let shown = 0;
            for (const group of menuGroups) {
                const matches = group.entries.filter((entry) => !query
                    || `${group.label} ${entry.label}`.toLowerCase().includes(query));
                if (!matches.length) continue;
                manager.menuBox.appendChild(el('div', { class: 'clop-shortcut-menu-group' }, [group.label]));
                for (const entry of matches) {
                    shown += 1;
                    const added = saved.has(shortcutIdentity(entry.target));
                    const addButton = el('button', {
                        class: `btn btn-xs ${added ? 'btn-default' : 'btn-primary'}`,
                        type: 'button',
                        onclick: () => {
                            const item = newShortcut(entry.label, entry.target);
                            if (!item) return;
                            commit([...items(), item]);
                            dismissShortcutOnboarding();
                        },
                    }, [added ? '✓ Added' : 'Add']);
                    addButton.disabled = added;
                    manager.menuBox.appendChild(el('div', { class: 'clop-shortcut-menu-entry' }, [
                        el('span', {}, [entry.label]),
                        addButton,
                    ]));
                }
            }
            if (!shown) manager.menuBox.appendChild(el('p', { class: 'text-muted' }, ['No menu destinations match.']));
        }

        function refreshUi() {
            renderBar();
            refreshSaveButton();
            if (manager) {
                renderManagerSaved();
                renderMenuPicker();
            }
            if (popover) {
                const input = popover.querySelector('input[data-shortcut-id]');
                const id = input && input.getAttribute('data-shortcut-id');
                const item = id && items().find((candidate) => candidate.id === id);
                if (id && !item) closePopover();
                else if (item && document.activeElement !== input) input.value = item.label;
            }
        }

        function updateStickyTop() {
            const style = window.getComputedStyle(nav);
            const pinned = style.position === 'fixed' || style.position === 'sticky';
            const top = pinned ? (parseFloat(style.top) || 0) + nav.getBoundingClientRect().height : 0;
            bar.style.top = `${Math.max(0, top)}px`;
        }

        core.events.on('shortcuts:changed', refreshUi);
        core.events.on('shortcuts:openManager', openManager);
        core.events.on('market:viewing', (view) => {
            marketView = {
                ...view,
                mode: view.mode || '',
                resourceId: String(view.resourceId || ''),
                resourceName: String(view.resourceName || ''),
            };
            refreshUi();
        });
        core.events.on('market:friendlyCache', renderBar);
        window.addEventListener('storage', (ev) => {
            if (shortcutStorageChange(ev.key)) refreshUi();
        });
        window.addEventListener('resize', updateStickyTop);
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateStickyTop).observe(nav);

        // Stock and userscript-generated navbar badges are the source of
        // truth.  Watching only the stock nav avoids a loop when their clones
        // are redrawn in the separate shortcut bar.
        let badgeRefreshQueued = false;
        const badgeMutation = (record) => {
            const target = record.target.nodeType === Node.ELEMENT_NODE
                ? record.target
                : record.target.parentElement;
            if (target && target.closest && target.closest('.badge')) return true;
            return [...record.addedNodes, ...record.removedNodes].some((node) => {
                if (node.nodeType !== Node.ELEMENT_NODE) return false;
                return node.matches('.badge') || !!node.querySelector('.badge');
            });
        };
        new MutationObserver((records) => {
            if (!records.some(badgeMutation)) return;
            if (badgeRefreshQueued) return;
            badgeRefreshQueued = true;
            queueMicrotask(() => {
                badgeRefreshQueued = false;
                renderBar();
            });
        }).observe(nav, { childList: true, characterData: true, subtree: true });

        core.shortcuts = {
            openManager,
            captureCurrent,
            items,
        };
        if (items().length && !shortcutOnboardingDismissed()) dismissShortcutOnboarding();
        updateStickyTop();
        refreshUi();
    },
};
