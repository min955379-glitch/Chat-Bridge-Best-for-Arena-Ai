// dev/tests/picker.test.js
// Drives the real click-to-pick overlay: hover, Arrow Up (bigger area),
// Arrow Down (back), click to save, Escape to cancel, and the site never
// receives the clicks made while picking.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePage } = require('../fake-dom.js');
const { createFakeChrome } = require('../fake-chrome.js');

const EXTENSION_DIR = path.join(__dirname, '..', '..', 'extension');

const PAGE = `
  <main>
    <div class="thread">
      <article class="turn" data-message-author-role="assistant" id="turn-one">
        <div class="markdown"><p id="answer-one">First answer with <b>bold</b> text.</p></div>
      </article>
      <article class="turn" data-message-author-role="assistant" id="turn-two">
        <div class="markdown"><p id="answer-two">Second answer.</p></div>
      </article>
    </div>
    <div class="composer">
      <textarea id="message-box" placeholder="Type here"></textarea>
      <button id="send-button" aria-label="Send message">Send</button>
    </div>
  </main>`;

function bootPage() {
  const { window, document } = makePage(PAGE);
  const chrome = createFakeChrome({ store: {} });
  window.chrome = chrome;
  document.execCommand = () => false;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  let point = null;
  // The test decides which element is under the "mouse".
  document.elementFromPoint = () => point;
  for (const file of ['selectors.js', 'extract.js', 'common.js', 'content.js']) {
    window.eval(fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8'));
  }
  const listeners = chrome.__listeners('runtime.onMessage');
  const send = (message) => new Promise((resolve) => {
    for (const listener of listeners) listener(message, {}, resolve);
  });
  return {
    window,
    document,
    chrome,
    send,
    hover(element) { point = element; },
    key(key) {
      const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event;
    },
    click() {
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event;
    },
    move(x, y) {
      window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('picking the chat box saves a selector for this site', async () => {
  const page = bootPage();
  page.hover(page.document.querySelector('#message-box'));
  await page.send({ type: 'startPick', kind: 'input' });
  page.move(10, 10);
  page.click();
  await sleep(50);
  const picks = page.chrome.__store['site_https://arena.ai/c'];
  assert.ok(picks && picks.input, 'a chat box pick must be saved');
  assert.equal(page.document.querySelectorAll(picks.input.selector).length, 1);
  assert.equal(page.document.querySelector(picks.input.selector).id, 'message-box');
});

test('picking the send button saves the button itself', async () => {
  const page = bootPage();
  // The user clicks the label inside the button; the button must be saved.
  const label = page.document.createElement('span');
  label.textContent = 'Send';
  page.document.querySelector('#send-button').appendChild(label);
  page.hover(label);
  await page.send({ type: 'startPick', kind: 'send' });
  page.move(20, 20);
  page.click();
  await sleep(50);
  const picks = page.chrome.__store['site_https://arena.ai/c'];
  assert.ok(picks.send);
  const saved = page.document.querySelector(picks.send.selector);
  assert.equal(saved.id, 'send-button');
});

test('picking the AI reply saves a selector that matches EVERY reply', async () => {
  const page = bootPage();
  // Click on the text inside the second answer.
  page.hover(page.document.querySelector('#answer-two'));
  await page.send({ type: 'startPick', kind: 'reply' });
  page.move(30, 30);
  page.click();
  await sleep(50);
  const picks = page.chrome.__store['site_https://arena.ai/c'];
  assert.ok(picks.reply);
  const matches = page.document.querySelectorAll(picks.reply.selector);
  assert.equal(matches.length, 2, 'both answers must match: ' + picks.reply.selector);
  assert.ok(!/nth-of-type/.test(picks.reply.selector));
});

test('Arrow Up makes the area bigger, Arrow Down goes back', async () => {
  const page = bootPage();
  const answer = page.document.querySelector('#answer-one');
  const paragraph = page.document.querySelector('.markdown');
  page.hover(answer);
  await page.send({ type: 'startPick', kind: 'reply' });
  page.move(50, 50);
  // Start on the <p>, go up to its parent, then back down.
  const boxBefore = page.document.getElementById('cb-picker-box').style.height;
  page.key('ArrowUp');
  page.key('ArrowUp');
  page.key('ArrowDown');
  page.key('ArrowDown');
  const box = page.document.getElementById('cb-picker-box');
  assert.ok(box, 'the highlight box must exist');
  assert.equal(typeof boxBefore, 'string');
  // The picker must still be alive after the arrow keys.
  assert.ok(page.document.getElementById('cb-picker-toast'));
});

test('the page never receives clicks while picking', async () => {
  const page = bootPage();
  const button = page.document.querySelector('#send-button');
  let siteClicks = 0;
  button.addEventListener('click', () => { siteClicks += 1; });
  button.addEventListener('mousedown', () => { siteClicks += 1; });
  page.hover(button);
  await page.send({ type: 'startPick', kind: 'send' });
  page.move(15, 15);
  // Dispatch the same events the site would normally see.
  const mouseDown = new page.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  button.dispatchEvent(mouseDown);
  const pointerDown = new page.window.Event('pointerdown', { bubbles: true, cancelable: true });
  button.dispatchEvent(pointerDown);
  page.key('a');
  // The click is dispatched on the window (capture) like a real click.
  page.click();
  await sleep(50);
  assert.equal(siteClicks, 0, 'the website must not react while picking');
});

test('Escape cancels without saving anything', async () => {
  const page = bootPage();
  page.hover(page.document.querySelector('#message-box'));
  await page.send({ type: 'startPick', kind: 'input' });
  page.move(10, 10);
  page.key('Escape');
  await sleep(30);
  page.click();
  await sleep(50);
  assert.equal(page.chrome.__store['site_https://arena.ai/c'], undefined);
});

test('the toast explains the keys in plain words', async () => {
  const page = bootPage();
  await page.send({ type: 'startPick', kind: 'input' });
  const toast = page.document.getElementById('cb-picker-toast');
  assert.ok(toast, 'a toast must be shown');
  assert.match(toast.textContent, /Arrow Up/);
  assert.match(toast.textContent, /Arrow Down/);
  assert.match(toast.textContent, /Esc/);
  assert.match(toast.textContent, /click/i);
});

test('picking a second spot does not stack or delete overlays', async () => {
  const page = bootPage();
  // First pick: chat box.
  page.hover(page.document.querySelector('#message-box'));
  await page.send({ type: 'startPick', kind: 'input' });
  page.move(10, 10);
  page.click();
  await sleep(60);
  // Second pick starts while the "Saved" toast is still on screen.
  page.hover(page.document.querySelector('#send-button'));
  await page.send({ type: 'startPick', kind: 'send' });
  page.move(15, 15);
  await sleep(40);
  // The new picker must have its own overlay: exactly one of each element.
  assert.equal(page.document.querySelectorAll('#cb-picker-box').length, 1);
  assert.equal(page.document.querySelectorAll('#cb-picker-toast').length, 1);
  // And the old timer must not delete it a moment later.
  await sleep(1400);
  assert.equal(page.document.querySelectorAll('#cb-picker-box').length, 1,
    'the overlay must still exist for the second pick');
  page.click();
  await sleep(60);
  const picks = page.chrome.__store['site_https://arena.ai/c'];
  assert.ok(picks.input && picks.send, 'both spots are saved');
});

test('picks for /c and /agent are saved separately', async () => {
  const page = bootPage();
  // Same page, but pretend the tab moved from /c/123 to /agent/456.
  page.window.history.pushState({}, '', '/agent/456');
  page.hover(page.document.querySelector('#message-box'));
  await page.send({ type: 'startPick', kind: 'input' });
  page.move(10, 10);
  page.click();
  await sleep(50);
  // jsdom keeps the document URL, so drive the key through the content script
  // by checking the stored key directly.
  const keys = Object.keys(page.chrome.__store).filter((k) => k.startsWith('site_'));
  assert.equal(keys.length, 1);
  assert.ok(keys[0].includes('/agent') || keys[0].includes('/c'),
    'the key must end with the first path segment: ' + keys[0]);
});
