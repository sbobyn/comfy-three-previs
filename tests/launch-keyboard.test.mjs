// Keyboard-only walkthrough of the main flow (open a starter, change the camera, open Generate video, review a quote) and the traps
// it found: a step tab that skipped a step, focus dropped to the page after a pane rebuild or a button that disables itself, dialogs
// opened from the More menu that returned focus nowhere, and a quote that appeared without focus or announcement.
// Only Tab, Shift+Tab, Enter, Space, Escape and arrow keys are used after the page loads. Needs the built app, playwright-core and
// Chrome/Chromium; Comfy Cloud is mocked (tests/fixtures/mock-cloud.mjs) and paid generation is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, skipReason, SIZES } from './fixtures/a11y-app.mjs';

/** A short description of the focused element, "BODY" when nothing has focus, and whether it is inside a dialog. */
const focus = page => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { body: true, text: 'BODY', dialog: false };
  return { body: false, dialog: !!a.closest('dialog'), text: `${a.tagName.toLowerCase()} “${(a.getAttribute('aria-label') || a.textContent || a.value || '').trim().replace(/\s+/g, ' ').slice(0, 40)}”` };
});
const tabUntil = async (page, match, { key = 'Tab', max = 150 } = {}) => {
  for (let i = 0; i < max; i++) { await page.keyboard.press(key); if (match(await focus(page))) return i + 1; }
  assert.fail(`not reachable by ${key} in ${max} stops (now at ${(await focus(page)).text})`);
};
/** Tab around a modal dialog: focus may leave the page for the browser's own chrome (reported as BODY) but never reaches the page behind. */
const stayInside = async (page, n = 40) => { const escaped = []; for (let i = 0; i < n; i++) { await page.keyboard.press('Tab'); const f = await focus(page); if (!f.body && !f.dialog) escaped.push(f.text); } return escaped; };
const dialogs = page => page.evaluate(() => document.querySelectorAll('dialog[open]').length);
const said = (page, re) => page.waitForFunction(([src]) => [...document.querySelectorAll('.sr-live')].some(e => new RegExp(src).test(e.textContent || '')), [re.source], { timeout: 5000 });

test('keyboard only: starter → camera → Generate video → quote, with no focus lost and no trap', { skip: skipReason, timeout: 180_000 }, async () => {
  const app = await startApp({ starter: null });
  try {
    const page = await app.page(SIZES[0][1]);
    await page.goto(`${app.base}/`, { waitUntil: 'networkidle' });

    // Home: "Open a starter" moves focus to the first starter, Enter opens it.
    await tabUntil(page, f => f.text.includes('Open a starter'));
    await page.keyboard.press('Enter');
    assert.match((await focus(page)).text, /Breaking News/, 'focus follows the scroll to the first starter');
    await page.keyboard.press('Enter');
    await page.waitForURL(/director\.html\?project=/); await page.waitForSelector('.outline .obj', { state: 'attached' });
    const projectId = new URL(page.url()).searchParams.get('project');
    const project = async () => (await (await fetch(`${app.base}/api/director/project?id=${projectId}`)).json()).project;
    const step = () => page.evaluate(() => document.querySelector('.step-btn[aria-selected=true]').dataset.step);

    // Steps: the arrow keys move one step at a time (two handlers once made ArrowRight skip Shoot).
    await tabUntil(page, f => f.text.includes('Build'));
    assert.equal(await step(), 'build');
    await page.keyboard.press('ArrowRight'); assert.equal(await step(), 'shoot', 'ArrowRight: Build → Shoot');
    await page.keyboard.press('ArrowRight'); assert.equal(await step(), 'cut', 'ArrowRight: Shoot → Cut');
    await page.keyboard.press('ArrowLeft'); assert.equal(await step(), 'shoot', 'ArrowLeft: Cut → Shoot');
    await page.keyboard.press('Home'); assert.equal(await step(), 'build', 'Home: first step');
    await page.keyboard.press('End'); assert.equal(await step(), 'cut', 'End: last step');
    await page.keyboard.press('ArrowLeft'); assert.equal(await step(), 'shoot');
    await page.waitForSelector('.shotpane [data-sec="camera"]', { state: 'attached' });

    // Camera: the Lens field changes with the arrow keys, saves when focus leaves, and focus is not dropped when the pane rebuilds.
    const before = (await project()).shots[0].camera.mm;
    await page.locator('.shotpane input[aria-label="Lens"]').focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Tab');
    await page.waitForFunction(async ([base, id, mm]) => (await (await fetch(`${base}/api/director/project?id=${id}`)).json()).project.shots[0].camera.mm !== mm, [app.base, projectId, before]);
    await page.waitForTimeout(300);
    assert.equal((await focus(page)).body, false, `focus survives the rebuild after a save (${(await focus(page)).text})`);
    // A camera key from the current view: Enter on the button, focus stays on it.
    await page.getByRole('button', { name: 'Set end from view' }).focus(); await page.keyboard.press('Enter');
    await said(page, /Camera end set/);
    assert.match((await focus(page)).text, /Set end from view/, 'focus stays on the button that rebuilt its pane');

    // Generate video: opens with focus inside, contains Tab, closes with Escape and returns focus to its opener. The camera edit made the
    // starter's stills stale, so the quote below is checked on a second, untouched shot.
    const opener = page.locator('.act-go');
    await opener.focus(); await page.keyboard.press('Enter'); await page.waitForSelector('dialog[open]');
    assert.equal((await focus(page)).dialog, true, 'focus moves into the dialog');
    assert.deepEqual(await stayInside(page), [], 'Tab never reaches the page behind the dialog');
    await page.keyboard.press('Escape');
    assert.equal(await dialogs(page), 0, 'Escape closes it');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('act-go')), true, 'focus returns to the opener');

    // Quote on the shot whose stills are still current (the second): Generate ▸ makes the blockout if needed, then quotes.
    await page.locator('.shot').nth(1).focus(); await page.keyboard.press('Enter');
    await opener.focus(); await page.keyboard.press('Enter'); await page.waitForSelector('dialog[open]');
    await tabUntil(page, f => f.text.includes('Generate ▸'), { max: 20 });
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog[open] .prompt-box[aria-label="Quote to review"]', { timeout: 60_000 });
    await said(page, /Quote ready: /);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Quote to review');
    await page.keyboard.press('Tab');
    assert.equal((await focus(page)).dialog, true, 'Tab from the quote goes on through the quote’s own controls');
    await page.keyboard.press('Escape');

    // More menu → Library: closing the dialog returns focus to More (the menu item that opened it is hidden by then).
    await page.locator('.help-menu-btn').focus(); await page.keyboard.press('Enter');
    assert.match((await focus(page)).text, /Library/, 'the menu opens on its first item');
    await page.keyboard.press('Enter'); await page.waitForSelector('#assets-dialog[open]');
    assert.deepEqual(await stayInside(page, 60), []);
    await page.keyboard.press('Escape');
    assert.match((await focus(page)).text, /More/, 'focus returns to More after Escape');
    await page.context().close();
  } finally { await app.stop(); }
});
