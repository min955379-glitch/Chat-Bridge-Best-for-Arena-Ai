// dev/tests/content.test.js
// Loads the real content.js inside a jsdom page that looks like a chat site,
// then checks pasting, sending, the reply reading and the picker.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePage } = require('../fake-dom.js');
const { createFakeChrome } = require('../fake-chrome.js');

const EXTENSION_DIR = path.join(__dirname, '..', '..', 'extension');

// A page with the structure chat sites really use: many messages, hash
// classes, a ProseMirror-style contenteditable box and a send button that
// starts disabled and becomes enabled when there is text.
const CHAT_PAGE = `
  <div id="app">
    <main class="conversation" role="main">
      <div class="message-row" data-message-author-role="user">
        <div class="bubble"><p>What is 2 + 2?</p></div>
      </div>
      <div class="message-row" data-message-author-role="assistant" data-testid="assistant-turn">
        <div class="markdown prose">
          <p>Let me think about that.</p>
          <p id="answer-one">The answer is 4.</p>
          <pre><code>2 + 2 = 4</code></pre>
        </div>
      </div>
      <div class="message-row" data-message-author-role="user">
        <div class="bubble"><p>Thanks</p></div>
      </div>
      <div class="message-row" data-message-author-role="assistant" data-testid="assistant-turn">
        <div class="markdown prose">
          <p id="answer-two">You are welcome.</p>
        </div>
      </div>
    </main>
    <form class="composer css-1x2y3z">
      <div contenteditable="true" role="textbox" aria-label="Write a message"
           data-testid="composer-input" id="box"></div>
      <button type="button" id="send" aria-label="Send message" disabled>Send</button>
    </form>
  </div>`;

// Boot the content script inside a page, wired to a fake chrome object.
function boot(html, store) {
  const { window, document } = makePage(html);
  const chrome = createFakeChrome({ store: store || {} });
  window.chrome = chrome;
  window.__chatBridgeLoaded = false;

  // jsdom has no execCommand, getSelection ranges are limited and there is no
  // layout. Fill in the small parts the content script needs.
  document.execCommand = function execCommand(command, showUi, value) {
    const active = document.activeElement;
    if (command === 'insertText' && active && active.isContentEditable) {
      active.textContent = value;
      active.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
      return true;
    }
    if (command === 'delete' && active && active.isContentEditable) {
      active.textContent = '';
      return true;
    }
    return false;
  };
  window.getSelection = () => ({
    removeAllRanges() {},
    addRange() {},
    getRangeAt() { return document.createRange(); },
    rangeCount: 0
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  document.elementFromPoint = () => null;
  window.elementFromPoint = (...args) => document.elementFromPoint(...args);

  // Load the helper files, then content.js, in page order.
  for (const file of ['selectors.js', 'extract.js', 'common.js', 'content.js']) {
    const code = fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8');
    window.eval(code);
  }

  // Call the content script through the message listener it registered.
  const listeners = chrome.__listeners('runtime.onMessage');
  const send = (message) => new Promise((resolve, reject) => {
    let answered = false;
    const sendResponse = (reply) => {
      if (answered) return;
      answered = true;
      resolve(reply);
    };
    for (const listener of listeners) listener(message, {}, sendResponse);
    setTimeout(() => { if (!answered) reject(new Error('content script did not answer ' + message.type)); }, 15000);
  });

  return { window, document, chrome, send };
}

const PICKS = {
  input: { selector: '[data-testid="composer-input"]', kind: 'input' },
  send: { selector: '#send', kind: 'send' },
  reply: { selector: '[data-message-author-role="assistant"]', kind: 'reply' }
};

test('readReply returns the LAST assistant reply and the match count', async () => {
  const page = boot(CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  const reply = await page.send({ type: 'readReply' });
  assert.equal(reply.ok, true);
  assert.equal(reply.count, 2);
  assert.match(reply.text, /You are welcome/);
  assert.ok(!reply.text.includes('The answer is 4'), 'must be the newest reply only');
  assert.equal(reply.code, '', 'the newest reply has no code block');
});

test('readReply reports a page that changed', async () => {
  const page = boot(CHAT_PAGE, { 'site_https://arena.ai/c': {} });
  const reply = await page.send({ type: 'readReply' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /AI reply is not picked/);
});

// Bug 1: a brand-new chat has no AI reply yet. That is not an error, and it
// must not stop the chat from being used as Tab A or Tab B.
const EMPTY_CHAT_PAGE = `
  <div id="app">
    <main class="conversation" role="main">
      <div class="message-row" data-message-author-role="user">
        <div class="bubble"><p>Hello, first message.</p></div>
      </div>
    </main>
    <form class="composer">
      <div contenteditable="true" role="textbox" aria-label="Write a message" id="box"></div>
      <button type="button" id="send" aria-label="Send message">Send</button>
    </form>
  </div>`;

test('a chat with no AI reply yet reads as empty instead of failing', async () => {
  const page = boot(EMPTY_CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  const reply = await page.send({ type: 'readReply' });
  assert.equal(reply.ok, true, 'an empty chat is a normal reading');
  assert.equal(reply.count, 0);
  assert.equal(reply.text, '');
  assert.equal(reply.code, '');
  assert.equal(reply.error, undefined);
});

test('Test copy explains an empty chat in plain words, and the pick is kept', async () => {
  const page = boot(EMPTY_CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  const copy = await page.send({ type: 'testCopy', key: 'https://arena.ai/c', settings: { mode: 'full' } });
  assert.equal(copy.ok, true);
  assert.equal(copy.count, 0);
  assert.match(copy.error, /No AI reply was found on this page/);
  assert.match(copy.error, /Pick AI reply/);

  // The picker is not to blame yet: waiting for the AI to answer and trying
  // again is the fix. But once the selector matched and then stopped, the
  // message changes, because then the page really did move.
  const working = await page.send({ type: 'readReply' });
  assert.equal(working.count, 0);
  await page.document.body.insertAdjacentHTML('beforeend',
    '<div class="message-row" data-message-author-role="assistant"><p>The answer is 4.</p></div>');
  const afterAnswer = await page.send({ type: 'readReply' });
  assert.equal(afterAnswer.count, 1);
  page.document.querySelectorAll('[data-message-author-role="assistant"]').forEach((el) => el.remove());
  const copyAgain = await page.send({ type: 'testCopy', key: 'https://arena.ai/c', settings: { mode: 'full' } });
  assert.match(copyAgain.error, /The AI reply is not on the page right now/);
});

test('the last code block of the newest reply is read on the page', async () => {
  const page = boot(CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  // Use the testCopy helper with the "code" mode; the newest reply has none.
  const copy = await page.send({
    type: 'testCopy', key: 'https://arena.ai/c', settings: { mode: 'code' }
  });
  assert.match(copy.error, /No code block found/);
});

test('testPaste writes into the contenteditable box without sending', async () => {
  const page = boot(CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  const result = await page.send({
    type: 'testPaste', key: 'https://arena.ai/c', text: 'test'
  });
  assert.equal(result.error, undefined, result.error);
  const box = page.document.getElementById('box');
  assert.equal(box.textContent, 'test');
  assert.match(result.note, /NOT sent/i);
});

test('deliver pastes the text, enables the button and clicks Send', async () => {
  const page = boot(CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  const box = page.document.getElementById('box');
  const button = page.document.getElementById('send');
  let clicked = false;
  // The site enables its button when the box gets text, like real sites do.
  box.addEventListener('input', () => { button.disabled = false; });
  button.addEventListener('click', () => { clicked = true; });

  const result = await page.send({ type: 'deliver', text: 'Hello from the other AI' });
  assert.equal(result.error, undefined, result.error);
  assert.equal(box.textContent, 'Hello from the other AI');
  assert.equal(clicked, true, 'the send button must be clicked');
});

test('multi-line text keeps its line breaks in the chat box', async () => {
  const page = boot(CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  const box = page.document.getElementById('box');
  const button = page.document.getElementById('send');
  box.addEventListener('input', () => { button.disabled = false; });
  await page.send({ type: 'deliver', text: 'line one\nline two\nline three' });
  assert.equal(box.textContent, 'line one\nline two\nline three');
});

test('a textarea chat box is filled the React-safe way', async () => {
  const html = `
    <main>
      <div class="reply-list">
        <div class="ai-answer">old answer</div>
      </div>
      <textarea id="prompt" placeholder="Message"></textarea>
      <button id="go" aria-label="Send">Send</button>
    </main>`;
  const page = boot(html, {
    'site_https://arena.ai/c': {
      input: { selector: '#prompt', kind: 'input' },
      send: { selector: '#go', kind: 'send' },
      reply: { selector: '.ai-answer', kind: 'reply' }
    }
  });
  const textarea = page.document.getElementById('prompt');
  let inputFired = 0;
  let changeFired = 0;
  let clicked = false;
  textarea.addEventListener('input', () => { inputFired += 1; });
  textarea.addEventListener('change', () => { changeFired += 1; });
  page.document.getElementById('go').addEventListener('click', () => { clicked = true; });

  const result = await page.send({ type: 'deliver', text: 'typed by the extension' });
  assert.equal(result.error, undefined, result.error);
  assert.equal(textarea.value, 'typed by the extension');
  assert.ok(inputFired >= 1, 'an input event must fire so React notices');
  assert.ok(changeFired >= 1, 'a change event must fire');
  assert.equal(clicked, true);
});

test('when no send button is picked, Enter is pressed instead', async () => {
  const page = boot(CHAT_PAGE, {
    'site_https://arena.ai/c': { input: PICKS.input, reply: PICKS.reply }
  });
  const box = page.document.getElementById('box');
  const keys = [];
  box.addEventListener('keydown', (event) => keys.push(event.key));
  const result = await page.send({ type: 'deliver', text: 'press enter please' });
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(keys, ['Enter']);
});

test('picking a wrapper around the box still finds the real box', async () => {
  const html = `
    <main>
      <div class="reply-list"><div class="ai-answer">old answer</div></div>
      <div class="composer-shell" id="shell">
        <div class="toolbar"><button id="attach">Attach</button></div>
        <textarea id="prompt" placeholder="Message"></textarea>
      </div>
      <button id="go" aria-label="Send">Send</button>
    </main>`;
  const page = boot(html, {
    'site_https://arena.ai/c': {
      // The user pressed Arrow Up and saved the wrapper, not the textarea.
      input: { selector: '#shell', kind: 'input' },
      send: { selector: '#go', kind: 'send' },
      reply: { selector: '.ai-answer', kind: 'reply' }
    }
  });
  const textarea = page.document.getElementById('prompt');
  page.document.getElementById('go').addEventListener('click', () => {});
  const result = await page.send({ type: 'deliver', text: 'found the real box' });
  assert.equal(result.error, undefined, result.error);
  assert.equal(textarea.value, 'found the real box');
});

test('a disabled send button is waited for, then clicked', async () => {
  const page = boot(CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  const button = page.document.getElementById('send');
  let clicked = false;
  button.addEventListener('click', () => { clicked = true; });
  // The site needs a moment before it enables the button.
  setTimeout(() => { button.disabled = false; }, 1200);
  const result = await page.send({ type: 'deliver', text: 'wait for the button' });
  assert.equal(result.error, undefined, result.error);
  assert.equal(clicked, true);
});

test('clear error when the chat box selector no longer matches', async () => {
  const page = boot(CHAT_PAGE, {
    'site_https://arena.ai/c': {
      input: { selector: '#no-such-box', kind: 'input' },
      send: PICKS.send,
      reply: PICKS.reply
    }
  });
  const result = await page.send({ type: 'deliver', text: 'hello' });
  assert.match(result.error, /Chat box not found/);
  assert.match(result.error, /pick the chat box again/);
});

test('a saved point finds the element again after the class names change', async () => {
  // The page is re-rendered: the old selector stops matching, but the point
  // where the user clicked still holds the chat box.
  const page = boot(CHAT_PAGE, {
    'site_https://arena.ai/c': {
      input: { selector: '#old-selector-that-is-gone', kind: 'input', x: 40, y: 60 },
      send: PICKS.send,
      reply: PICKS.reply
    }
  });
  const box = page.document.getElementById('box');
  page.document.elementFromPoint = () => box;
  const result = await page.send({ type: 'testPaste', key: 'https://arena.ai/c', text: 'test' });
  assert.equal(result.error, undefined, result.error);
  assert.equal(box.textContent, 'test');
});

test('two helper files load only once (double injection is harmless)', () => {
  const page = boot(CHAT_PAGE, {});
  assert.equal(page.window.__chatBridgeLoaded, true);
  // Loading content.js again must not register a second listener.
  const before = page.chrome.__listeners('runtime.onMessage').length;
  const code = fs.readFileSync(path.join(EXTENSION_DIR, 'content.js'), 'utf8');
  page.window.eval(code);
  const after = page.chrome.__listeners('runtime.onMessage').length;
  assert.equal(after, before);
});

// ---------- Smart Helper part 2: the newest group of answer cards ----------
// Arena battle mode shows several answer cards for one turn: they are
// siblings that share the parent of the last match.
const BATTLE_PAGE = `
  <div id="app">
    <main class="conversation" role="main">
      <div class="turn-pair">
        <div class="message-row" data-message-author-role="user">
          <div class="bubble"><p>Write a function that adds two numbers.</p></div>
        </div>
        <div class="answer-card" data-message-author-role="assistant" data-card="1">
          <div class="prose"><p>Short answer: a + b.</p></div>
        </div>
      </div>
      <div class="turn-pair">
        <div class="message-row" data-message-author-role="user">
          <div class="bubble"><p>Now do it again, better.</p></div>
        </div>
        <div class="answer-card" data-message-author-role="assistant" data-card="1">
          <div class="prose"><p>First card of the new turn, the weaker one.</p></div>
        </div>
        <div class="answer-card" data-message-author-role="assistant" data-card="2">
          <div class="prose">
            <p>Second card of the new turn: the complete answer.</p>
            <pre><code>function add(a, b) { return a + b; }</code></pre>
          </div>
        </div>
      </div>
    </main>
    <form class="composer">
      <div contenteditable="true" role="textbox" aria-label="Write a message" id="box"></div>
      <button type="button" id="send" aria-label="Send message">Send</button>
    </form>
  </div>`;

test('readReplyGroup returns every card of the newest turn only', async () => {
  const page = boot(BATTLE_PAGE, { 'site_https://arena.ai/c': PICKS });
  const group = await page.send({ type: 'readReplyGroup' });
  assert.equal(group.ok, true);
  assert.equal(group.count, 2, 'only the two cards of the newest turn');
  assert.match(group.cards[0].text, /First card of the new turn/);
  assert.match(group.cards[1].text, /Second card of the new turn/);
  // The older turn is never included.
  assert.ok(!group.cards.some((card) => /Short answer/.test(card.text)));
  // Each card carries its own code block.
  assert.match(group.cards[1].code, /function add/);
  assert.equal(group.cards[0].code, '');
});

// A page where the newest answer really is alone in its own turn container.
const SINGLE_TURN_PAGE = `
  <div id="app">
    <main class="conversation" role="main">
      <div class="turn-pair">
        <div class="message-row" data-message-author-role="user"><p>First question.</p></div>
        <div class="message-row" data-message-author-role="assistant"><p>The first answer.</p></div>
      </div>
      <div class="turn-pair">
        <div class="message-row" data-message-author-role="user"><p>Second question.</p></div>
        <div class="message-row" data-message-author-role="assistant"><p>The second answer.</p></div>
      </div>
    </main>
  </div>`;

test('readReplyGroup with one answer returns that one card', async () => {
  const page = boot(SINGLE_TURN_PAGE, { 'site_https://arena.ai/c': PICKS });
  const group = await page.send({ type: 'readReplyGroup' });
  assert.equal(group.ok, true);
  assert.equal(group.count, 1, 'the newest answer is alone in its turn');
  assert.match(group.cards[0].text, /The second answer/);
});

test('readReplyGroup on an empty chat returns no cards and no error', async () => {
  const page = boot(EMPTY_CHAT_PAGE, { 'site_https://arena.ai/c': PICKS });
  const group = await page.send({ type: 'readReplyGroup' });
  assert.equal(group.ok, true);
  assert.equal(group.count, 0);
  assert.equal(group.cards.length, 0, 'no cards at all');
});

test('readReplyGroup asks for a pick first when the reply is not picked', async () => {
  const page = boot(CHAT_PAGE, { 'site_https://arena.ai/c': {} });
  const group = await page.send({ type: 'readReplyGroup' });
  assert.equal(group.ok, false);
  assert.match(group.error, /AI reply is not picked/);
});
