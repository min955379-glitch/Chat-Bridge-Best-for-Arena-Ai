// dev/tests/extract.test.js
// Checks the three copy modes and the "is the reply still typing?" helper.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDoc, h } = require('../fake-dom.js');
const Extract = require('../../extension/extract.js');

const pair = { start: 'START', end: 'END' };

test('full mode returns the whole reply', () => {
  const doc = makeDoc(h('div', { id: 'r' }, h('p', {}, 'line one'), h('p', {}, 'line two')));
  const out = Extract.applyModeToElement(doc.querySelector('#r'), 'full', pair);
  assert.equal(out.text, 'line one\nline two');
});

test('last code block mode reads the last pre/code', () => {
  const doc = makeDoc(h('div', { id: 'r' },
    h('p', {}, 'Here is code:'),
    h('pre', {}, h('code', {}, 'first();')),
    h('p', {}, 'And more:'),
    h('pre', {}, h('code', {}, 'second();\nthird();'))));
  const out = Extract.applyModeToElement(doc.querySelector('#r'), 'code', pair);
  assert.equal(out.text, 'second();\nthird();');
});

test('last code block mode also works when only <pre> is used', () => {
  const doc = makeDoc(h('div', { id: 'r' }, h('p', {}, 'text'), h('pre', {}, 'plain pre')));
  const out = Extract.applyModeToElement(doc.querySelector('#r'), 'code', pair);
  assert.equal(out.text, 'plain pre');
});

test('last code block mode explains when there is no code', () => {
  const doc = makeDoc(h('div', { id: 'r' }, h('p', {}, 'no code here')));
  const out = Extract.applyModeToElement(doc.querySelector('#r'), 'code', pair);
  assert.match(out.error, /No code block found/);
});

test('between markers uses the LAST START and the first END after it', () => {
  const text = [
    'Some thinking FIRST START old text END',
    'More thinking...',
    'START',
    'the real message line 1',
    'the real message line 2',
    'END',
    'trailing text'
  ].join('\n');
  const out = Extract.betweenMarkers(text, pair);
  assert.equal(out.text, 'the real message line 1\nthe real message line 2');
});

test('between markers keeps multi-line text and trims the edges', () => {
  const out = Extract.betweenMarkers('x\nSTART\n\n  a\n\n  b\n\nEND\ny', pair);
  assert.equal(out.text, 'a\n\n  b');
});

test('between markers explains a missing START', () => {
  const out = Extract.betweenMarkers('nothing here', pair);
  assert.match(out.error, /could not find the START marker "START"/);
});

test('between markers explains a missing END', () => {
  const out = Extract.betweenMarkers('START but the end is missing', pair);
  assert.match(out.error, /no END marker "END"/);
});

test('between markers explains an empty middle', () => {
  const out = Extract.betweenMarkers('STARTEND', pair);
  assert.match(out.error, /empty/);
});

test('custom markers work', () => {
  const out = Extract.betweenMarkers('BEGIN hello there STOP', { start: 'BEGIN', end: 'STOP' });
  assert.equal(out.text, 'hello there');
});

test('the default markers are START and END when the fields are blank', () => {
  const out = Extract.betweenMarkers('START hi END', { start: '   ', end: '' });
  assert.equal(out.text, 'hi');
});

test('code mode on plain text finds the last fenced block (API answers)', () => {
  const text = 'Look:\n```js\nconst a = 1;\n```\nand also:\n```py\nprint("hi")\n```\nbyebye';
  const out = Extract.applyModeToText(text, 'code', pair);
  assert.equal(out.text, 'print("hi")');
});

test('plain text code mode explains when there is no fence', () => {
  const out = Extract.applyModeToText('no fences', 'code', pair);
  assert.match(out.error, /No code block found/);
});

test('the empty reply case is explained', () => {
  const out = Extract.applyModeToText('   ', 'full', pair);
  assert.match(out.error, /empty/);
});

test('looksUnfinished spots an open code fence', () => {
  assert.equal(Extract.looksUnfinished('typing...\n```js\nconst x ='), true);
  assert.equal(Extract.looksUnfinished('done\n```js\nconst x = 1;\n```'), false);
  assert.equal(Extract.looksUnfinished('no code at all'), false);
});

test('preview shows at most the limit and adds an ellipsis', () => {
  assert.equal(Extract.preview('short', 200), 'short');
  assert.equal(Extract.preview('x'.repeat(300), 200).length, 201);
});

test('cleanText normalises Windows newlines', () => {
  assert.equal(Extract.cleanText('a\r\nb'), 'a\nb');
  assert.equal(Extract.cleanText('  a  '), 'a');
});

test('mode labels are the words shown in the popup', () => {
  assert.deepEqual(Object.values(Extract.MODE_LABELS), ['Full reply', 'Last code block', 'Between markers']);
});
