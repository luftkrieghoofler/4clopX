// Adapter for resource deals. The incoming stock page has no
// wrapper or machine-readable payload per deal, so each Accept form is
// paired with the Offered/Requested Items tables immediately preceding it.

function displayedAmount(text) {
    const normalized = String(text || '').replace(/,/g, '').trim();
    if (!/^\d+$/.test(normalized)) return null;
    const amount = Number(normalized);
    return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function itemsFromTable(table) {
    const items = [];
    for (const row of table.querySelectorAll('tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        const name = cells[0].textContent.trim();
        const amount = displayedAmount(cells[1].textContent);
        if (name && amount) items.push({ name, amount });
    }
    return items;
}

function containsForm(node) {
    return node.matches('form') || !!node.querySelector('form');
}

export function incomingDealFromForm(form) {
    const accept = form.querySelector('input[name="acceptdeal"], button[name="acceptdeal"]');
    if (!accept) return null;

    const offered = [];
    const requested = [];
    let bitsRequested = null;
    const start = form.parentElement && form.parentElement.matches('center')
        ? form.parentElement
        : form;

    for (let node = start.previousElementSibling; node; node = node.previousElementSibling) {
        if (containsForm(node)) break;
        const moneyLine = String(node.textContent || '').trim();
        const money = moneyLine.match(/^requests ([\d,]+) bits from you for this deal$/i);
        if (money) bitsRequested = displayedAmount(money[1]);
        else if (/^(?:offers [\d,]+ bits for this deal|does not involve money in this deal)$/i.test(moneyLine)) {
            bitsRequested = 0;
        }
        const table = node.matches('table') ? node : node.querySelector('table');
        if (!table) continue;
        const headingContainer = node.previousElementSibling;
        const heading = headingContainer && headingContainer.querySelector('h4');
        const label = heading ? heading.textContent.trim() : '';
        if (label === 'Offered Items') offered.push(...itemsFromTable(table));
        if (['Requested Items', 'Requested Weapons', 'Requested Armor'].includes(label)) {
            requested.push(...itemsFromTable(table));
        }
    }

    const dealId = form.querySelector('input[name="deal_id"]');
    return {
        form,
        accept,
        dealId: dealId ? dealId.value : null,
        offered,
        requested,
        bitsRequested,
    };
}

export function incomingDealsFromDocument(doc) {
    const deals = [];
    for (const form of doc.querySelectorAll('#content form')) {
        const deal = incomingDealFromForm(form);
        if (deal) deals.push(deal);
    }
    return deals;
}

// backend_makedeal.php charges this per item added on EITHER side of a
// draft. Offered items/bits are removed immediately, not on finalization.
const ITEM_DEAL_FEE = 100;

export function outgoingDealFromForm(form, submitter) {
    const intent = submitter?.name;
    if (!['offeritem', 'askitem', 'offermoney'].includes(intent)) return null;
    const raw = form.querySelector('input[name="amount"]')?.value.trim() || '';
    const amount = Number(raw);
    // Empty/zero/negative amounts cannot spend stock; leave rejection to the
    // server. Do not guess PHP's coercion of malformed or fractional amounts.
    if (Number.isFinite(amount) && amount <= 0) return null;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(amount)) {
        throw new Error('Could not read the deal quantity as a whole number');
    }
    if (intent === 'offermoney') {
        return { offered: [], requested: [], bitsRequested: amount, operation: `Offer ${amount.toLocaleString('en-US')} Bits` };
    }
    const option = form.querySelector('select[name="resource_id"]')?.selectedOptions[0];
    const name = option?.textContent.trim().replace(/\s+\(Have [\d,]+\)$/, '');
    if (!name) throw new Error('Could not read the item selected for the deal');
    const bitsRequested = amount * ITEM_DEAL_FEE;
    if (!Number.isSafeInteger(bitsRequested)) throw new Error('The deal quantity is too large to check safely');
    return {
        // These fields describe what OUR nation receives/spends. Requests
        // are not received until acceptance, so never credit them here.
        offered: [],
        requested: intent === 'offeritem' ? [{ name, amount }] : [],
        bitsRequested,
        operation: `${intent === 'offeritem' ? 'Offer' : 'Request'} ${amount.toLocaleString('en-US')} ${name}`,
    };
}
