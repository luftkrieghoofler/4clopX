import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogsModule } from '../src/ui/dialogs.js';
import { affordabilityDialogOptions } from '../src/ui/affordability-warning.js';
import { upkeepRiskListItem } from '../src/ui/upkeep-warning.js';
import { upkeepRiskForChange } from '../src/lib/upkeep-safety.js';

// Minimal DOM for exercising the real dialog event/Promise lifecycle without
// a browser dependency. Native details layout and styling need browser review.
function dialogHarness(t) {
    const original = globalThis.document;
    const doc = new EventTarget();
    const nodes = [];
    function el(tag, attrs = {}, children = []) {
        const node = new EventTarget();
        Object.assign(node, {
            tag, attrs, children: [], parent: null, disabled: false, open: false,
            isConnected: true, classList: { add() {}, remove() {} },
            appendChild(child) {
                this.children.push(child);
                child.parent = this;
                return child;
            },
            remove() {
                if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
                this.isConnected = false;
            },
            focus() { doc.activeElement = this; },
            contains(other) { return other === this || this.children.some((child) => child.contains(other)); },
            querySelectorAll() {
                return this.children.flatMap((child) => [
                    ...(['button', 'summary'].includes(child.tag) && !child.disabled ? [child] : []),
                    ...child.querySelectorAll(),
                ]);
            },
            click() { if (!this.disabled) this.dispatchEvent(new Event('click')); },
        });
        Object.defineProperty(node, 'firstElementChild', { get: () => node.children[0] });
        Object.defineProperty(node, 'textContent', {
            get: () => tag === '#text' ? attrs.text : node.children.map((child) => child.textContent).join(''),
        });
        for (const child of children) node.appendChild(typeof child === 'string' ? el('#text', { text: child }) : child);
        nodes.push(node);
        return node;
    }
    doc.body = el('body');
    doc.activeElement = el('input');
    doc.createTextNode = (text) => el('#text', { text });
    globalThis.document = doc;
    t.after(() => { globalThis.document = original; });
    const core = { el, commas: String, addStyle() {} };
    dialogsModule.init(core);
    return { core, doc, nodes };
}

const shortages = [{ name: 'Copper', required: 50, stock: 35, shortage: 15 }];

test('affordability defaults to OK and offers a direct attempt only without other warnings', async (t) => {
    const { core, doc, nodes } = dialogHarness(t);
    const previousFocus = doc.activeElement;
    const result = core.confirm(affordabilityDialogOptions(core, shortages, {}));
    await Promise.resolve();
    const buttons = nodes.filter((node) => node.tag === 'button');
    const ok = buttons.find((node) => node.textContent === 'OK');
    const attempt = buttons.find((node) => node.textContent === 'Attempt anyway');
    assert.equal(doc.activeElement, ok);
    assert.equal(ok.attrs.class, 'btn btn-primary');
    assert.equal(attempt.attrs.class, 'btn btn-link');
    assert.equal(nodes.some((node) => node.tag === 'details'), false);
    assert.match(doc.body.textContent, /Copper: need 50, stock 35 — short by 15/);
    ok.click();
    assert.equal(await result, false);
    assert.equal(doc.activeElement, previousFocus);

    const retry = core.confirm(affordabilityDialogOptions(core, shortages, {}));
    await Promise.resolve();
    nodes.findLast((node) => node.tag === 'button' && node.textContent === 'Attempt anyway').click();
    assert.equal(await retry, true);
});

test('reviewing warnings never submits and the revealed button completes one confirmation', async (t) => {
    const { core, doc, nodes } = dialogHarness(t);
    let settled = false;
    let opened = 0;
    let cleaned = 0;
    const warning = upkeepRiskListItem(core, upkeepRiskForChange(
        { name: 'Copper', qty: 35, used: 10 }, { stockChange: -50 }));
    const result = core.confirm(affordabilityDialogOptions(core, shortages, {
        body: core.el('ul', {}, [warning]),
        warningCount: 1,
        onOpen() { opened += 1; return () => { cleaned += 1; }; },
    })).then((value) => { settled = true; return value; });
    await Promise.resolve();
    const review = nodes.find((node) => node.tag === 'details');
    const proceed = nodes.find((node) => node.tag === 'button' && node.textContent === 'Proceed anyway');
    assert.match(review.firstElementChild.textContent, /review 1 safety warning$/);
    assert.equal(review.open, false);
    assert.equal(proceed.disabled, true);
    assert.equal(review.contains(proceed), true);
    assert.match(review.textContent, /stock decreases from 35 to -15; current consumption is 10 — short by 25/);
    proceed.click();
    await Promise.resolve();
    assert.equal(settled, false);

    review.open = true;
    review.dispatchEvent(new Event('toggle'));
    assert.equal(proceed.disabled, false);
    assert.equal(settled, false, 'expansion only reveals information');
    review.open = false;
    review.dispatchEvent(new Event('toggle'));
    assert.equal(proceed.disabled, true);
    review.open = true;
    review.dispatchEvent(new Event('toggle'));
    proceed.click();
    assert.equal(await result, true);
    assert.equal(opened, 1);
    assert.equal(cleaned, 1, 'tick-warning lifecycle ends with the single dialog');
    assert.equal(doc.body.children.length, 0);
});

test('Escape dismisses expanded warnings and Tab skips a collapsed proceed button', async (t) => {
    const { core, doc, nodes } = dialogHarness(t);
    const result = core.confirm(affordabilityDialogOptions(core, shortages, {
        body: 'Safety details', warningCount: 2,
    }));
    await Promise.resolve();
    const ok = doc.activeElement;
    const review = nodes.find((node) => node.tag === 'details');
    assert.match(review.firstElementChild.textContent, /review 2 safety warnings$/);
    const tab = new Event('keydown', { cancelable: true });
    Object.assign(tab, { key: 'Tab', shiftKey: false });
    doc.dispatchEvent(tab);
    assert.equal(doc.activeElement.attrs.class, 'close', 'Tab wraps from OK to the close button');
    const back = new Event('keydown', { cancelable: true });
    Object.assign(back, { key: 'Tab', shiftKey: true });
    doc.dispatchEvent(back);
    assert.equal(doc.activeElement, ok);
    review.open = true;
    review.dispatchEvent(new Event('toggle'));
    const escape = new Event('keydown', { cancelable: true });
    Object.assign(escape, { key: 'Escape' });
    doc.dispatchEvent(escape);
    assert.equal(await result, false);
});

test('affordable requests retain their ordinary safety confirmation', async (t) => {
    const { core, doc, nodes } = dialogHarness(t);
    const options = { body: 'Upkeep warning', confirmLabel: 'Sell anyway' };
    assert.equal(affordabilityDialogOptions(core, [], options), options);
    const result = core.confirm(options);
    await Promise.resolve();
    assert.equal(doc.activeElement.textContent, 'Cancel');
    assert.equal(doc.activeElement.attrs.class, 'btn btn-default');
    const proceed = nodes.find((node) => node.tag === 'button' && node.textContent === 'Sell anyway');
    assert.equal(proceed.attrs.class, 'btn btn-danger');
    proceed.click();
    assert.equal(await result, true);
});
