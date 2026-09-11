// Ordinary safety warnings share one coloured container. Sections own both
// their heading and details, regardless of which operation triggered them.
export function warningSection(core, heading, items, description = '') {
    return core.el('section', { class: 'clop-warning-section' }, [
        core.el('strong', { class: 'clop-warning-heading' }, [heading]),
        ...(description ? [core.el('div', { class: 'clop-warning-description' }, [description])] : []),
        core.el('ul', { class: 'clop-confirm-risk-list' }, items),
    ]);
}

export function warningGroup(core, sections) {
    const visible = sections.filter(Boolean);
    return visible.length ? core.el('div', { class: 'alert alert-warning' }, visible) : null;
}

export function rateRiskListItem(core, name, before, after, note = '') {
    // Army upkeep is averaged over six ticks, so rates may be fractional.
    const signed = (value) => {
        const rounded = Math.round(value * 100) / 100;
        return rounded > 0 ? `+${core.commas(rounded)}` : core.commas(rounded);
    };
    return core.el('li', {}, [
        core.el('strong', {}, [`${name}:`]),
        ` net/tick decreases from ${signed(before)} to `,
        core.el('strong', {}, [signed(after)]),
        note ? ` (${note}).` : '.',
    ]);
}
