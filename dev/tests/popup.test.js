// dev/tests/popup.test.js
// Opens the real popup.html in jsdom with a fake chrome API and checks that
// every control exists, the settings save, the picks show ticks and the
// Start button talks to the background worker.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createFakeChrome } = require('../fake-chrome.js');

const EXTENSION_DIR = path.join(__dirname, '..', '..', 'extension');

function openPopup(store, options) {
  const opts = options || {};
  const html = fs.readFileSync(path.join(EXTENSION_DIR, 'popup.html'), 'utf8');
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'chrome-extension://test/popup.html'
  });
  const { window } = dom;
  const chrome = createFakeChrome({ store: store || {} });
  chrome.tabs.query = async () => [{
    id: 42,
    url: 'https://arena.ai/agent/xyz',
    title: 'Arena agent'
  }];
  chrome.tabs.create = () => {};
  chrome.runtime.sendMessage = (message, callback) => {
    const replies = opts.backgroundReplies || {};
    const reply = replies[message.type] || { ok: true };
    setTimeout(() => callback(reply), 0);
  };
  window.chrome = chrome;
  // The popup calls tabs.sendMessage with a callback.
  chrome.tabs.sendMessage = (tabId, message, callback) => {
    const reply = (opts.pageReplies || {})[message.type] || { ok: true };
    setTimeout(() => callback(reply), 0);
  };
  window.close = () => { window.__closed = true; };
  window.navigator.clipboard = { writeText: async () => {} };

  for (const file of ['common.js', 'extract.js', 'popup.js']) {
    window.eval(fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8'));
  }
  return {
    window,
    document: window.document,
    chrome,
    event(type) { return new window.Event(type || 'change', { bubbles: true }); }
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the popup has every control the brief asks for', async () => {
  const { document } = openPopup();
  await wait(20);
  const ids = [
    'site-label', 'tick-input', 'tick-send', 'tick-reply',
    'pick-input', 'pick-send', 'pick-reply', 'test-copy', 'test-paste',
    'clear-picks', 'make-a', 'make-b', 'roles-line',
    'rounds', 'silence', 'copy-mode-a', 'copy-mode-b', 'marker-start', 'marker-end',
    'prefix', 'suffix', 'stop-if-same', 'stop-word', 'mode', 'timeout', 'max-rounds',
    'provider', 'gemini-key', 'gemini-model', 'grok-key', 'grok-model', 'memory',
    'system-prompt', 'start', 'stop', 'status', 'log', 'copy-log'
  ];
  for (const id of ids) assert.ok(document.getElementById(id), 'missing control: ' + id);
  // The popup is narrow, as the brief asks.
  const css = fs.readFileSync(path.join(EXTENSION_DIR, 'popup.css'), 'utf8');
  assert.match(css, /width:\s*340px/);
});

test('the API keys are password fields', async () => {
  const { document } = openPopup();
  await wait(20);
  assert.equal(document.getElementById('gemini-key').type, 'password');
  assert.equal(document.getElementById('grok-key').type, 'password');
});

test('the settings fields show the saved values', async () => {
  const { document } = openPopup({
    settings: { rounds: 3, silence: 20, copyModeA: 'markers', markerStart: 'BEGIN', prefix: 'hey' }
  });
  await wait(30);
  assert.equal(document.getElementById('rounds').value, '3');
  assert.equal(document.getElementById('silence').value, '20');
  assert.equal(document.getElementById('copy-mode-a').value, 'markers');
  assert.equal(document.getElementById('marker-start').value, 'BEGIN');
  assert.equal(document.getElementById('prefix').value, 'hey');
});

test('the three ticks follow the picks saved for this site', async () => {
  const { document } = openPopup({
    'site_https://arena.ai/agent': {
      input: { selector: '#box' },
      reply: { selector: '.answer' }
    }
  });
  await wait(30);
  assert.equal(document.getElementById('tick-input').textContent, '✓');
  assert.equal(document.getElementById('tick-reply').textContent, '✓');
  assert.equal(document.getElementById('tick-send').textContent, '○');
  assert.match(document.getElementById('tick-input').className, /done/);
});

test('the site label shows the site of the active tab', async () => {
  const { document } = openPopup();
  await wait(30);
  assert.equal(document.getElementById('site-label').textContent, 'arena.ai/agent');
});

test('changing a setting saves it after a moment', async () => {
  const page = openPopup({ settings: { rounds: 5 } });
  const { document, chrome } = page;
  await wait(30);
  const rounds = document.getElementById('rounds');
  rounds.value = '4';
  rounds.dispatchEvent(page.event('input'));
  await wait(500);
  assert.equal(chrome.__store.settings.rounds, 4);
});

test('an empty rounds field falls back to the default, never NaN', async () => {
  const page = openPopup({ settings: { rounds: 5 } });
  const { document, chrome } = page;
  await wait(30);
  const rounds = document.getElementById('rounds');
  rounds.value = '';
  rounds.dispatchEvent(page.event('input'));
  await wait(500);
  assert.equal(chrome.__store.settings.rounds, 5);
});

test('choosing "Make this Tab A" stores the tab id and a title', async () => {
  const page = openPopup();
  const { document, chrome } = page;
  await wait(30);
  document.getElementById('make-a').dispatchEvent(page.event('click'));
  await wait(50);
  assert.equal(chrome.__store.roles.A, 42);
  assert.equal(chrome.__store.roleTitles['42'], 'Arena agent');
  assert.match(document.getElementById('make-a').textContent, /Tab A/);
});

test('the same tab cannot be both A and B', async () => {
  const page = openPopup({ roles: { A: 42, B: null } });
  const { document, chrome } = page;
  await wait(30);
  document.getElementById('make-b').dispatchEvent(page.event('click'));
  await wait(50);
  assert.equal(chrome.__store.roles.B, null);
  assert.match(document.getElementById('test-text').textContent, /already Tab A/);
});

test('the mode selector shows the API section only in API mode', async () => {
  const page = openPopup({ settings: { mode: 'tab' } });
  const { document } = page;
  await wait(30);
  assert.equal(document.getElementById('api-settings').hidden, true);
  const mode = document.getElementById('mode');
  mode.value = 'api';
  mode.dispatchEvent(page.event('change'));
  await wait(30);
  assert.equal(document.getElementById('api-settings').hidden, false);
  assert.match(document.getElementById('mode-badge').textContent, /API/);
});

test('the status line and log render what the worker wrote', async () => {
  const { document, chrome } = openPopup({
    status: { text: 'Round 2/5: sending A → B', tone: 'running', running: true },
    log: [
      { t: Date.now() - 2000, text: 'Run started in tab to tab mode.' },
      { t: Date.now(), text: 'Sending 120 characters from A to B.' }
    ]
  });
  await wait(30);
  const status = document.getElementById('status');
  assert.equal(status.textContent, 'Round 2/5: sending A → B');
  assert.match(status.className, /running/);
  assert.equal(document.getElementById('log').children.length, 2);
  assert.match(document.getElementById('log').textContent, /Sending 120 characters/);
  // Start is disabled while a run is going; Stop is enabled.
  assert.equal(document.getElementById('start').disabled, true);
  assert.equal(document.getElementById('stop').disabled, false);
});

test('live status updates from the worker reach the popup', async () => {
  const { document, chrome } = openPopup();
  await wait(30);
  await chrome.storage.local.set({ status: { text: 'Done', tone: 'done', running: false } });
  await wait(20);
  assert.equal(document.getElementById('status').textContent, 'Done');
  assert.equal(document.getElementById('start').disabled, false);
});

test('Start sends the start message to the worker', async () => {
  let asked = false;
  const page = openPopup({}, {
    backgroundReplies: { start: { ok: true } }
  });
  const { document } = page;
  await wait(30);
  document.getElementById('start').addEventListener('click', () => { asked = true; });
  document.getElementById('start').dispatchEvent(page.event('click'));
  await wait(50);
  assert.equal(asked, true);
});

test('the Start button is live again after the run finishes', async () => {
  // The worker answers "start" late (when the run ends), like the real one.
  const page = openPopup({ status: { text: 'Ready.', tone: 'idle', running: false } }, {
    backgroundReplies: { start: { ok: true } }
  });
  const { document, chrome } = page;
  await wait(30);
  document.getElementById('start').dispatchEvent(page.event('click'));
  await wait(60);
  // While running, Start is disabled and Stop is enabled.
  await chrome.storage.local.set({ status: { text: 'Round 1/1: sending A → B', tone: 'running', running: true } });
  await wait(20);
  assert.equal(document.getElementById('start').disabled, true);
  assert.equal(document.getElementById('stop').disabled, false);
  // When the run is over, Start must work again.
  await chrome.storage.local.set({ status: { text: 'Finished all 1 round.', tone: 'done', running: false } });
  await wait(20);
  assert.equal(document.getElementById('start').disabled, false);
  assert.equal(document.getElementById('stop').disabled, true);
});

test('a start error is shown in plain words', async () => {
  const page = openPopup({}, {
    backgroundReplies: { start: { error: 'Tab B is not chosen yet.' } }
  });
  const { document } = page;
  await wait(30);
  document.getElementById('start').dispatchEvent(page.event('click'));
  await wait(50);
  assert.match(document.getElementById('test-text').textContent, /Tab B is not chosen yet/);
  assert.match(document.getElementById('test-title').textContent, /Cannot start/);
});

test('Test copy shows the first 200 characters and the match count', async () => {
  const longText = 'x'.repeat(500);
  const page = openPopup(
    { 'site_https://arena.ai/agent': { reply: { selector: '.answer' } } },
    { pageReplies: { testCopy: { ok: true, count: 3, text: longText.slice(0, 200), length: 200 } } }
  );
  const { document } = page;
  await wait(30);
  document.getElementById('test-copy').dispatchEvent(page.event('click'));
  await wait(80);
  const shown = document.getElementById('test-text').textContent;
  assert.match(shown, /3 replies match/);
  assert.ok(shown.length < 400, 'the preview must stay short');
});

test('Test paste reports that the text was not sent', async () => {
  const page = openPopup(
    { 'site_https://arena.ai/agent': { input: { selector: '#box' } } },
    { pageReplies: { testPaste: { ok: true, note: 'Done: "test" is in the chat box. It was NOT sent.' } } }
  );
  const { document } = page;
  await wait(30);
  document.getElementById('test-paste').dispatchEvent(page.event('click'));
  await wait(80);
  assert.match(document.getElementById('test-text').textContent, /NOT sent/);
});

test('Clear picks removes the picks for this site only', async () => {
  const page = openPopup({
    'site_https://arena.ai/agent': { input: { selector: '#box' } },
    'site_https://arena.ai/c': { input: { selector: '#other' } }
  });
  const { document, chrome } = page;
  await wait(30);
  document.getElementById('clear-picks').dispatchEvent(page.event('click'));
  await wait(50);
  assert.equal(chrome.__store['site_https://arena.ai/agent'], undefined);
  assert.ok(chrome.__store['site_https://arena.ai/c'], 'other sites keep their picks');
  assert.equal(document.getElementById('tick-input').textContent, '○');
});


