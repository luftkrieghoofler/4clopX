// Shared reserve and risk semantics for Actions, Deals, and marketplace
// sales. Callers remain responsible for calculating their domain-specific
// stock/upkeep deltas and for deciding how to present or confirm a risk.

export function protectedReserve(resource) {
    const used = Number(resource && resource.used) || 0;
    const military = Number(resource && resource.mil) || 0;
    const reserve = used + military;
    return Number.isSafeInteger(reserve) ? reserve : null;
}

// Largest whole number of operations that can consume amountPerUse while
// leaving the protected reserve untouched.  Market sales use one unit per
// operation; actions such as Distribute Apples can consume several.
export function reserveSafeMax(stock, reserve, amountPerUse = 1) {
    if (![stock, reserve, amountPerUse].every(Number.isSafeInteger)
        || stock < 0 || reserve < 0 || amountPerUse < 1) return null;
    return Math.floor(Math.max(0, stock - reserve) / amountPerUse);
}

export function upkeepRiskForChange(resource, {
    name = resource && resource.name,
    stockChange = 0,
    reserveChange = 0,
} = {}) {
    const stockBefore = Number(resource && resource.qty) || 0;
    const reserveBefore = protectedReserve(resource);
    if (reserveBefore === null
        || ![stockBefore, stockChange, reserveChange].every(Number.isSafeInteger)) return null;

    const stockAfter = stockBefore + stockChange;
    const reserveAfter = Math.max(0, reserveBefore + reserveChange);
    if (![stockAfter, reserveAfter].every(Number.isSafeInteger)) return null;

    // The server rejects an operation it cannot afford instead of allowing
    // negative inventory, so that operation cannot create an upkeep risk.
    if (stockAfter < 0) return null;

    // Do not nag about an unrelated existing shortage: the operation must
    // make stock or required reserve worse and leave the result unsafe.
    if (stockAfter >= reserveAfter || (stockChange >= 0 && reserveChange <= 0)) return null;

    return {
        name: name || 'Unknown resource',
        stockBefore,
        stockAfter,
        stockChange,
        reserveBefore,
        reserveAfter,
        reserveChange,
        shortage: reserveAfter - stockAfter,
    };
}
