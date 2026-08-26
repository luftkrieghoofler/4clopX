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

export function actionsFromDocument(doc) {
    const actions = new Map();
    for (const form of doc.querySelectorAll('form')) {
        const id = recipeId(form);
        if (!id || !form.querySelector('input[name="token_actions"]')) continue;
        actions.set(id, {
            id,
            name: actionName(form),
            description: actionDescription(form),
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

export function submittedAction(form, submitter, page) {
    const id = recipeId(form);
    if (!id) return null;
    const intent = submitter ? submitter.name : '';
    if (page === 'actions.php' && intent === 'favorite') return null;
    if (page === 'favoriteactions.php' && intent === 'remove') return null;
    return { id, times: phpInteger(form.querySelector('[name="times"]')?.value) };
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
