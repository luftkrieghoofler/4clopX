// Presentation grouping stays separate from the modules' setting definitions.
const SECTION_NAMES = {
    'Auto-login': 'General',
    Actions: 'Actions & deals',
    Deals: 'Actions & deals',
    Market: 'Markets',
};
const SECTION_ORDER = [
    'General', 'Live updates', 'Overview', 'Actions & deals',
    'Markets', 'Market favourites', 'Shortcuts',
];

export function settingsSections(definitions) {
    const groups = new Map(SECTION_ORDER.map((label) => [label, []]));
    for (const def of definitions) {
        const label = SECTION_NAMES[def.section] || def.section || 'General';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(def);
    }
    return [...groups].filter(([label, defs]) => defs.length || label === 'Market favourites');
}

// Each section keeps its own DOM and scroll position. Blur before hiding or
// removing anything: native change handlers commit edits on focus loss.
export function createSettingsSections(core, sections, { selected, onSelect }, doc = document) {
    const el = core.el.bind(core);
    const nav = el('div', {
        class: 'clop-settings-nav', role: 'tablist',
        'aria-label': 'Settings sections', 'aria-orientation': 'vertical',
    });
    const content = el('div', { class: 'clop-settings-content' });
    const node = el('div', { class: 'clop-settings-layout' }, [nav, content]);
    const entries = new Map();
    let active = null;

    function commitFocused() {
        const focused = doc.activeElement;
        if (focused && node.contains(focused)) focused.blur();
    }

    function select(label) {
        const entry = entries.get(label);
        if (!entry) return;
        if (active !== label) commitFocused();
        for (const [name, item] of entries) {
            const current = name === label;
            item.button.classList.toggle('active', current);
            item.button.setAttribute('aria-selected', String(current));
            item.button.tabIndex = current ? 0 : -1;
            item.panel.hidden = !current;
        }
        active = label;
        if (!entry.mounted) {
            entry.mount(entry.panel);
            entry.mounted = true;
        }
        onSelect(label);
        entry.button.focus();
    }

    sections.forEach(({ label, mount }, index) => {
        const id = `clop-settings-section-${index}`;
        const button = el('button', {
            class: 'clop-settings-tab', type: 'button', role: 'tab',
            id: `${id}-tab`, 'aria-controls': id,
            onclick: () => select(label),
        }, [label]);
        const panel = el('section', {
            class: 'clop-settings-section', id, role: 'tabpanel',
            'aria-labelledby': `${id}-tab`, tabindex: '0',
        });
        panel.hidden = true;
        button.addEventListener('keydown', (ev) => {
            const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
            if (!keys.includes(ev.key)) return;
            ev.preventDefault();
            const count = sections.length;
            const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? count - 1
                : (index + (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 1) + count) % count;
            select(sections[next].label);
        });
        entries.set(label, { button, panel, mount, mounted: false });
        nav.appendChild(button);
        content.appendChild(panel);
    });

    return {
        node,
        select,
        start() {
            const label = entries.has(selected) ? selected : sections[0].label;
            select(label);
        },
        commitFocused,
    };
}
