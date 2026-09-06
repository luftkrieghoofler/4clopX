import { actionFormsFromDocument } from '../adapters/actions.js';
import { replacePageContent } from './page-content.js';
import { executeDynamicRequest } from './dynamic-request.js';

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

    await executeDynamicRequest(core, {
        send: () => {
            const params = new FormData(form);
            if (submitter?.name) params.append(submitter.name, submitterValue);
            return core.http.postForm(form.getAttribute('action')
                || (page === 'overview.php' ? 'favoriteactions.php' : page), params);
        },
        refresh,
        requestDescription: removing ? 'removal' : adding ? 'addition' : 'action',
        requestErrorTitle: removing ? 'Favourite removal failed' : adding ? 'Favourite addition failed' : 'Action request failed',
        successTitle: removing ? 'Favourite removed' : adding ? 'Favourite added' : 'Action complete',
        errorTitle: removing ? 'Could not remove favourite' : adding ? 'Could not add favourite' : 'Action failed',
        fallbackMessage: removing ? 'The favourite was removed.'
            : adding ? 'The favourite was added.' : 'The action was processed.',
    });
}
