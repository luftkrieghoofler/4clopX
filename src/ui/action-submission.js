import { isLoggedInDoc } from '../adapters/session.js';
import { actionFormsFromDocument } from '../adapters/actions.js';
import { replacePageContent } from './page-content.js';

export function replaceActionContent(currentDoc, sourceDoc) {
    const quantities = new Map();
    for (const { id, form } of actionFormsFromDocument(currentDoc)) {
        const input = form.querySelector('input[name="times"][type="text"]');
        if (input) quantities.set(id, input.value);
    }
    const result = replacePageContent(currentDoc, sourceDoc, undefined, { omitFeedback: true });
    if (!result.available) throw new Error('Could not find the action page content container.');
    for (const { id, form } of actionFormsFromDocument(currentDoc)) {
        const input = form.querySelector('input[name="times"][type="text"]');
        if (input && quantities.has(id)) input.value = quantities.get(id);
    }
}

export function isDynamicActionSubmission(page, form, submitter) {
    if (!form) return false;
    const intent = submitter?.name || '';
    if (page === 'actions.php') {
        return !!form.querySelector('input[name="token_actions"]')
            && (intent === '' || intent === 'favorite');
    }
    return (page === 'overview.php' || page === 'favoriteactions.php')
        && !!form.querySelector('input[name="token_favoriteactions"]')
        && (intent === '' || intent === 'perform' || intent === 'remove');
}

// One POST, never automatically retried: a lost response may still have
// performed the action. Refresh failures must likewise retain server feedback.
export async function executeDynamicAction(core, { page, form, submitter, refresh }) {
    const removing = submitter?.name === 'remove';
    const adding = submitter?.name === 'favorite';
    const submitterValue = submitter && (submitter.dataset.clopOldLabel
        || submitter.value || submitter.textContent);
    if (submitter) {
        const label = removing ? 'Removing…' : adding ? 'Adding…' : 'Performing…';
        if ('value' in submitter) submitter.value = label;
        else submitter.textContent = label;
    }

    let response;
    try {
        const params = new FormData(form);
        if (submitter?.name) params.append(submitter.name, submitterValue);
        response = await core.http.postForm(form.getAttribute('action')
            || (page === 'overview.php' ? 'favoriteactions.php' : page), params);
        if (!isLoggedInDoc(response)) throw new Error('The game session has expired.');
    } catch (error) {
        console.warn('[4clopX] action request failed:', error);
        core.feedback.error(
            `Could not confirm whether the ${removing ? 'removal' : adding ? 'addition' : 'action'} succeeded ` +
            `(${String(error.message || error)}). Reload the page before trying again.`, {
                title: removing ? 'Favourite removal failed' : adding ? 'Favourite addition failed' : 'Action request failed',
            });
        return;
    }

    try {
        await refresh(response);
        core.feedback.fromDocument(response, {
            successTitle: removing ? 'Favourite removed' : adding ? 'Favourite added' : 'Action complete',
            errorTitle: removing ? 'Could not remove favourite' : adding ? 'Could not add favourite' : 'Action failed',
            fallbackMessage: removing ? 'The favourite was removed.'
                : adding ? 'The favourite was added.' : 'The action was processed.',
        });
    } catch (error) {
        core.feedback.fromDocument(response, {
            errorTitle: 'Page refresh failed',
            additionalErrors: [
                `The server answered, but the page could not be fully refreshed ` +
                `(${String(error.message || error)}). Reload the page before trying again.`,
            ],
        });
        console.warn('[4clopX] refresh after action failed:', error);
    }
}
