// Shared presentation for any operation which would leave resource stock
// below the tick-consumption + military-upkeep reserve.

export function upkeepRiskListItem(core, risk) {
    const el = core.el.bind(core);
    const stockChanged = risk.stockBefore !== risk.stockAfter;
    const consumptionChanged = risk.reserveBefore !== risk.reserveAfter;
    const change = (label, before, after) => [
        `${label} ${after < before ? 'decreases' : 'increases'} from `,
        core.commas(before),
        ' to ',
        el('strong', {}, [core.commas(after)]),
    ];
    const details = [];

    if (stockChanged) details.push(...change('stock', risk.stockBefore, risk.stockAfter));
    if (stockChanged && consumptionChanged) details.push(' and ');
    if (consumptionChanged) {
        details.push(...change('consumption', risk.reserveBefore, risk.reserveAfter));
    }
    if (!stockChanged) {
        details.push('; current stock is ', core.commas(risk.stockAfter));
    } else if (!consumptionChanged) {
        details.push('; current consumption is ', core.commas(risk.reserveAfter));
    }
    details.push(
        ' — short by ',
        el('strong', {}, [core.commas(risk.shortage)]),
        ' for next tick.',
    );
    return el('li', {}, [
        el('strong', {}, [`${risk.name}:`]),
        ' ',
        ...details,
    ]);
}
