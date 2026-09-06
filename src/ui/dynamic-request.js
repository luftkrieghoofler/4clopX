import { isLoggedInDoc } from '../adapters/session.js';

// Never retry a mutation automatically: a lost response may still mean that
// the operation succeeded. Keep server messages even if the refresh fails.
export async function executeDynamicRequest(core, {
    send, refresh, requestDescription = 'action', requestErrorTitle = 'Action request failed',
    successTitle = 'Action complete', errorTitle = 'Action failed',
    fallbackMessage = 'The action was processed.',
}) {
    let response;
    try {
        response = await send();
        if (!isLoggedInDoc(response)) throw new Error('The game session has expired.');
    } catch (error) {
        console.warn('[4clopX] action request failed:', error);
        core.feedback.error(
            `Could not confirm whether the ${requestDescription} succeeded ` +
            `(${String(error.message || error)}). Reload the page before trying again.`, {
                title: requestErrorTitle,
            });
        return;
    }
    try {
        await refresh(response);
        core.feedback.fromDocument(response, { successTitle, errorTitle, fallbackMessage });
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
