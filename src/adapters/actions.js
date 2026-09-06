import { normalizeActionText } from '../lib/action-safety.js';

function recipeId(form) {
    const input = form.querySelector('input[name="recipe_id"]');
    return input && /^\d+$/.test(input.value) ? String(Number(input.value)) : null;
}

function actionDescription(form) {
    const cell = form.closest('td');
    if (!cell) return '';
    let text = '';
    for (const node of cell.childNodes) {
        if (node.nodeType === 1 && node.tagName.toLowerCase() === 'br') break;
        text += node.textContent || '';
    }
    return normalizeActionText(text);
}

function actionName(form) {
    const submits = form.querySelectorAll('input[type="submit"], button[type="submit"]');
    for (const submit of submits) {
        if (submit.name === 'favorite') continue;
        return normalizeActionText(submit.value || submit.textContent);
    }
    return '';
}

// The cost is its own line between the description's first <br> and the
// form. Read the live, region-adjusted amount rather than old catalogue costs.
export function actionBitsCost(form) {
    const cell = form.closest('td');
    if (!cell) return null;
    let afterDescription = false;
    let line = '';
    for (const node of cell.childNodes) {
        if (node === form) break;
        if (node.nodeType === 1 && node.tagName.toLowerCase() === 'br') {
            if (afterDescription) break;
            afterDescription = true;
        } else if (afterDescription) {
            line += node.textContent || '';
        }
    }
    const match = line.trim().match(/^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+))\s+bits$/i);
    if (!match) return null;
    const cost = Number(match[1].replace(/,/g, ''));
    return Number.isSafeInteger(cost) ? cost : null;
}

export function actionsFromDocument(doc) {
    const actions = new Map();
    for (const form of doc.querySelectorAll('form')) {
        const id = recipeId(form);
        if (!id || !form.querySelector('input[name="token_actions"]')) continue;
        actions.set(id, {
            id,
            name: actionName(form),
            description: actionDescription(form),
            bitsCost: actionBitsCost(form),
            form,
        });
    }
    return actions;
}

export function actionFormsFromDocument(doc) {
    const forms = [];
    for (const form of doc.querySelectorAll('form')) {
        const id = recipeId(form);
        if (!id) continue;
        if (!form.querySelector('input[name="token_actions"], input[name="token_favoriteactions"]')) continue;
        forms.push({ id, form });
    }
    return forms;
}

export function submittedAction(form, submitter) {
    const id = recipeId(form);
    if (!id) return null;
    const intent = submitter ? submitter.name : '';
    // These controls mutate the favourites list; they do not perform the
    // recipe.  Detect them by intent so embedded Favourite Actions (such as
    // those on overview.php) behave like the dedicated page.
    if (intent === 'favorite' || intent === 'remove') return null;
    return { id, times: phpInteger(actionTimesValue(form)) };
}

// Placeholders are visual only. Use the same effective value when checking
// safety, previewing Burn Oil, and constructing the actual POST.
export function actionTimesValue(form) {
    const input = form.querySelector('[name="times"]');
    return input?.type === 'text' && !input.value.trim() ? '1' : input?.value;
}

// Match PHP's integer conversion closely enough to avoid underestimating a
// submitted multiplier such as "2foo", "2.9", or exponential notation.
export function phpInteger(value) {
    const match = String(value ?? '').match(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i);
    if (!match) return 0;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return number < 0 ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    return Math.trunc(number);
}
