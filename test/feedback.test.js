import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_TOAST_DURATION, feedbackMessagesFromDocument,
} from '../src/ui/feedback.js';

function alert(textContent, itemSelector, items = []) {
    return {
        textContent,
        querySelectorAll: (selector) => selector === itemSelector
            ? items.map((message) => ({ textContent: message }))
            : [],
    };
}

test('dynamic feedback uses the short two-second toast duration', () => {
    assert.equal(DEFAULT_TOAST_DURATION, 2000);
});

test('extracts and normalizes stock response errors and information', () => {
    const errorAlert = alert('', '.error', [
        '  Not enough\n apples. ',
        'Try again.',
    ]);
    const infoAlert = alert('', '.info', ['  Built  3 farms.  ']);
    const directInfo = alert('Favourite removed.', '.info');
    const doc = {
        querySelectorAll(selector) {
            if (selector === '#content > .alert-danger') return [errorAlert];
            if (selector === '#content > .alert-info') return [infoAlert, directInfo];
            return [];
        },
    };

    assert.deepEqual(feedbackMessagesFromDocument(doc), {
        errors: ['Not enough apples.', 'Try again.'],
        infos: ['Built 3 farms.', 'Favourite removed.'],
    });
});
