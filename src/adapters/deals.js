// Adapter for incoming resource deals on deals.php. The stock page has no
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
    const start = form.parentElement && form.parentElement.matches('center')
        ? form.parentElement
        : form;

    for (let node = start.previousElementSibling; node; node = node.previousElementSibling) {
        if (containsForm(node)) break;
        const table = node.matches('table') ? node : node.querySelector('table');
        if (!table) continue;
        const headingContainer = node.previousElementSibling;
        const heading = headingContainer && headingContainer.querySelector('h4');
        const label = heading ? heading.textContent.trim() : '';
        if (label === 'Offered Items') offered.push(...itemsFromTable(table));
        if (label === 'Requested Items') requested.push(...itemsFromTable(table));
    }

    const dealId = form.querySelector('input[name="deal_id"]');
    return {
        form,
        accept,
        dealId: dealId ? dealId.value : null,
        offered,
        requested,
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
