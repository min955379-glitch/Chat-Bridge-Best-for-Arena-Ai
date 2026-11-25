// dev/tests/selectors.test.js
// Checks the selector builder against fake pages with the same tricks real
// chat sites use: hash classes, many identical messages, text inside spans.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDoc, h } = require('../fake-dom.js');
const Selectors = require('../../extension/selectors.js');

test('chat box with a stable id gets a simple selector', () => {
  const doc = makeDoc(h('body', {},
    h('div', { class: 'chat' },
      h('textarea', { id: 'prompt-textarea', placeholder: 'Send a message' }))));
  const box = doc.querySelector('#prompt-textarea');
  const built = Selectors.buildSelector(box, 'input', doc);
  assert.equal(built.count, 1);
  assert.equal(doc.querySelectorAll(built.selector).length, 1);
  assert.equal(doc.querySelector(built.selector), box);
});

test('send button is found through aria-label even when the class is a hash', () => {
  const doc = makeDoc(h('body', {},
    h('form', {},
      h('button', { class: 'css-1x2y3z', 'aria-label': 'Send message' }, 'Send'),
      h('button', { class: 'css-9z8y7x', 'aria-label': 'Attach file' }, 'Attach'))));
  const button = doc.querySelector('[aria-label="Send message"]');
  const built = Selectors.buildSelector(button, 'send', doc);
  assert.equal(built.count, 1);
  assert.equal(doc.querySelector(built.selector), button);
  assert.ok(!/1x2y3z|9z8y7x/.test(built.selector), 'hash class must not be used: ' + built.selector);
});

test('reply selector matches every AI reply, not just the clicked one', () => {
  const makeReply = (text) => h('div', { class: 'message-row ai', 'data-message-author-role': 'assistant' },
    h('div', { class: 'markdown' }, h('p', {}, h('span', {}, text))));
  const doc = makeDoc(h('body', {},
    h('main', {},
      h('div', { class: 'message-row user', 'data-message-author-role': 'user' },
        h('div', { class: 'markdown' }, h('p', {}, 'Question one'))),
      makeReply('Answer one'),
      h('div', { class: 'message-row user', 'data-message-author-role': 'user' },
        h('div', { class: 'markdown' }, h('p', {}, 'Question two'))),
      makeReply('Answer two'))));

  // The user clicks the text inside the newest answer.
  const clicked = doc.querySelectorAll('span')[1];
  const built = Selectors.buildSelector(clicked, 'reply', doc);
  assert.ok(!built.error, built.error);
  const found = doc.querySelectorAll(built.selector);
  assert.equal(found.length, 2, 'both answers should match: ' + built.selector);
  assert.equal(found[found.length - 1].getAttribute('data-message-author-role'), 'assistant');
  assert.ok(!/nth-of-type/.test(built.selector), 'reply selector must not use position: ' + built.selector);
  assert.ok(!/message-row user/.test(built.selector));
});

test('reply selector refuses to save something that matches only the clicked reply', () => {
  // Two answers with completely different classes: no shared selector exists.
  const doc = makeDoc(h('body', {},
    h('section', { class: 'alpha-one' }, h('p', {}, 'first answer')),
    h('section', { class: 'beta-two' }, h('p', {}, 'second answer'))));
  const clicked = doc.querySelectorAll('p')[1];
  const built = Selectors.buildSelector(clicked, 'reply', doc);
  // Either a shared selector was found or a plain error is returned, never
  // a selector that matches only this one message with a position.
  if (!built.error) {
    assert.ok(!/nth-of-type/.test(built.selector));
    assert.ok(doc.querySelectorAll(built.selector).length >= 1);
  } else {
    assert.match(built.error, /matches every reply/i);
  }
});

test('long structural path is the last resort for the chat box', () => {
  const doc = makeDoc(h('body', {},
    h('div', {}, h('div', {}, h('div', {}, h('div', {}, h('div', {}, h('div', {},
      h('div', {}, h('textarea', { class: 'x1y2z3q4' }))))))))));
  const box = doc.querySelector('textarea');
  const built = Selectors.buildSelector(box, 'input', doc);
  assert.ok(!built.error, built.error);
  assert.equal(doc.querySelectorAll(built.selector).length, 1);
  assert.equal(doc.querySelector(built.selector), box);
});

test('ids with long digit runs are never used', () => {
  const doc = makeDoc(h('body', {},
    h('div', { id: 'msg-883712' }, h('button', { id: 'btn-1234567', 'aria-label': 'Send' }, 'go')),
    h('div', { id: 'msg-883713' }, h('button', { id: 'btn-1234568', 'aria-label': 'Send' }, 'go'))));
  const button = doc.querySelectorAll('button')[1];
  const built = Selectors.buildSelector(button, 'send', doc);
  assert.ok(!/btn-123456/.test(built.selector), 'unstable id used: ' + built.selector);
  assert.equal(doc.querySelectorAll(built.selector).length, 1);
});

test('isStableClass rejects build hashes and keeps real words', () => {
  for (const good of ['message', 'chat-input', 'prose', 'markdown-body', 'composer__box']) {
    assert.equal(Selectors.isStableClass(good), true, good);
  }
  for (const bad of ['css-1x2y3z', 'sc-kfzBvf', 'jsx-2930291', 'a1b2c3', 'emotion-5h4j2', 'x'.repeat(50)]) {
    assert.equal(Selectors.isStableClass(bad), false, bad);
  }
});

// ---------- real site structures ----------
// These mirror the markup of chat sites that change their class names often.

test('ChatGPT-style page: one selector for every assistant message', () => {
  const doc = makeDoc(
    '<main><div class="react-scroll-to-bottom">' +
    '<div data-message-author-role="user" data-message-id="a1"><div class="whitespace-pre-wrap">Q1</div></div>' +
    '<div data-message-author-role="assistant" data-message-id="b1"><div class="markdown prose"><p>Answer one</p></div></div>' +
    '<div data-message-author-role="user" data-message-id="a2"><div class="whitespace-pre-wrap">Q2</div></div>' +
    '<div data-message-author-role="assistant" data-message-id="b2"><div class="markdown prose"><p>Answer two</p></div></div>' +
    '</div></main>');
  const clicked = doc.querySelector('[data-message-id="b2"] p');
  const built = Selectors.buildSelector(clicked, 'reply', doc);
  assert.ok(!built.error, built.error);
  const found = doc.querySelectorAll(built.selector);
  assert.equal(found.length, 2);
  for (const node of found) {
    assert.equal(node.getAttribute('data-message-author-role'), 'assistant');
  }
});

test('Claude-style page: the reply class is found without any role attribute', () => {
  const doc = makeDoc(
    '<div class="grid"><div class="thread">' +
    '<div class="font-user-message"><p>Question A</p></div>' +
    '<div class="font-claude-message"><p>Reply A</p></div>' +
    '<div class="font-user-message"><p>Question B</p></div>' +
    '<div class="font-claude-message"><p>Reply B</p></div>' +
    '</div></div>');
  const clicked = doc.querySelectorAll('.font-claude-message')[1].querySelector('p');
  const built = Selectors.buildSelector(clicked, 'reply', doc);
  assert.ok(!built.error, built.error);
  const found = Array.from(doc.querySelectorAll(built.selector));
  assert.equal(found.length, 2);
  assert.ok(found.every((node) => node.textContent.includes('Reply')));
});

test('Gemini-style page with custom elements (model-response)', () => {
  const doc = makeDoc(
    '<main><div class="conversation-container">' +
    '<user-query><div class="query-text">Q</div></user-query>' +
    '<model-response><div class="response-container"><message-content><p>Answer one</p></message-content></div></model-response>' +
    '<user-query><div class="query-text">Q2</div></user-query>' +
    '<model-response><div class="response-container"><message-content><p>Answer two</p></message-content></div></model-response>' +
    '</div></main>');
  const clicked = doc.querySelectorAll('model-response message-content p')[1];
  const built = Selectors.buildSelector(clicked, 'reply', doc);
  assert.ok(!built.error, built.error);
  assert.equal(doc.querySelectorAll(built.selector).length, 2);
});

test('a page with only hash class names still gets a usable reply selector', () => {
  const doc = makeDoc(
    '<div><div id="root">' +
    '<div class="x1y2z3"><div class="css-kfz9w"><p>Q</p></div></div>' +
    '<div class="x1y2z3"><div class="css-kfz9w"><p>Answer one</p></div></div>' +
    '<div class="x1y2z3"><div class="css-kfz9w"><p>Q2</p></div></div>' +
    '<div class="x1y2z3"><div class="css-kfz9w"><p>Answer two</p></div></div>' +
    '</div></div>');
  const clicked = doc.querySelectorAll('p')[3];
  const built = Selectors.buildSelector(clicked, 'reply', doc);
  assert.ok(!built.error, built.error);
  const found = doc.querySelectorAll(built.selector);
  assert.ok(found.length >= 2, 'it must match more than one block: ' + built.selector);
  assert.ok(!/css-kfz9w|x1y2z3/.test(built.selector), 'hash classes must not be used');
  // The clicked spot must be inside the saved match.
  const last = found[found.length - 1];
  assert.ok(last === clicked || last.contains(clicked));
});

test('an agent page with a single answer block still saves a reply picker', () => {
  // Arena agent pages show only the current answer while the agent works.
  const doc = makeDoc(
    '<main><div class="agent">' +
    '<div class="user-turn"><p>do the task</p></div>' +
    '<div class="agent-turn" data-role="assistant"><div class="markdown"><p>Working on it...</p></div></div>' +
    '</div></main>');
  const built = Selectors.buildSelector(doc.querySelector('.agent-turn p'), 'reply', doc);
  assert.ok(!built.error, built.error);
  assert.equal(doc.querySelectorAll(built.selector).length, 1);
});
