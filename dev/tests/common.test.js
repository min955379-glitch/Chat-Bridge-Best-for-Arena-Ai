// dev/tests/common.test.js
// Checks the site key rule, the settings defaults and the small helpers.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Common = require('../../extension/common.js');

test('site keys follow origin + first path segment', () => {
  assert.equal(Common.siteKeyFor('https://arena.ai/c/abc123'), 'https://arena.ai/c');
  assert.equal(Common.siteKeyFor('https://arena.ai/agent/xyz'), 'https://arena.ai/agent');
  assert.equal(Common.siteKeyFor('https://arena.ai/'), 'https://arena.ai/');
  assert.equal(Common.siteKeyFor('https://arena.ai'), 'https://arena.ai/');
  assert.equal(Common.siteKeyFor('https://claude.ai/chat/1234'), 'https://claude.ai/chat');
  assert.equal(Common.siteKeyFor('https://gemini.google.com/app/xyz'), 'https://gemini.google.com/app');
});

test('the same site with different chats shares one key', () => {
  assert.equal(
    Common.siteKeyFor('https://arena.ai/c/one'),
    Common.siteKeyFor('https://arena.ai/c/two'));
});

test('arena /c and arena /agent get separate keys, as required', () => {
  assert.notEqual(Common.siteKeyFor('https://arena.ai/c/x'), Common.siteKeyFor('https://arena.ai/agent/y'));
});

test('the site label is friendly', () => {
  assert.equal(Common.siteLabel('https://arena.ai/c/abc'), 'arena.ai/c');
  assert.equal(Common.siteLabel('https://claude.ai/new'), 'claude.ai/new');
  assert.equal(Common.siteLabel('not a url'), 'this page');
});

test('only http and https pages are supported', () => {
  assert.equal(Common.isSupportedUrl('https://arena.ai/c/1'), true);
  assert.equal(Common.isSupportedUrl('http://localhost:3000'), true);
  assert.equal(Common.isSupportedUrl('chrome://extensions'), false);
  assert.equal(Common.isSupportedUrl('file:///tmp/a.html'), false);
  assert.equal(Common.isSupportedUrl(undefined), false);
});

test('default settings match the specification', () => {
  const s = Common.normalizeSettings({});
  assert.equal(s.rounds, 5);
  assert.equal(s.silence, 8);
  assert.equal(s.timeout, 600);
  assert.equal(s.markerStart, 'START');
  assert.equal(s.markerEnd, 'END');
  assert.equal(s.copyModeA, 'full');
  assert.equal(s.copyModeB, 'full');
  assert.equal(s.mode, 'tab');
  assert.equal(s.provider, 'gemini');
  assert.equal(s.memory, 6);
  assert.equal(s.geminiModel, 'gemini-2.5-flash');
  assert.equal(s.grokModel, 'grok-4');
});

test('bad values fall back instead of breaking the run', () => {
  const s = Common.normalizeSettings({
    rounds: 'many', silence: -5, timeout: 1, copyModeA: 'nonsense', mode: 'wrong', provider: 'other'
  });
  assert.equal(s.rounds, 5);
  assert.equal(s.silence, 2);
  assert.equal(s.timeout, 30);
  assert.equal(s.copyModeA, 'full');
  assert.equal(s.mode, 'tab');
  assert.equal(s.provider, 'gemini');
});

test('rounds are capped by the safety limit and by 100', () => {
  assert.equal(Common.effectiveRounds({ rounds: 3, maxRounds: 100 }), 3);
  assert.equal(Common.effectiveRounds({ rounds: 50, maxRounds: 10 }), 10);
  assert.equal(Common.effectiveRounds({ rounds: 500, maxRounds: 500 }), 100);
});

test('the prefix and suffix are added around a message', () => {
  assert.equal(Common.wrapMessage('Before', 'body', 'After'), 'Before\n\nbody\n\nAfter');
  assert.equal(Common.wrapMessage('', 'body', ''), 'body');
  assert.equal(Common.wrapMessage('  ', 'body', '  '), 'body');
  assert.equal(Common.wrapMessage('Only prefix', 'body', ''), 'Only prefix\n\nbody');
});

test('API keys are hidden from messages', () => {
  const settings = { geminiKey: 'AIzaSECRET123456', grokKey: 'xai-SECRET7890' };
  const text = 'failed with key AIzaSECRET123456 and xai-SECRET7890';
  const hidden = Common.hideSecret(text, settings);
  assert.ok(!hidden.includes('AIzaSECRET123456'));
  assert.ok(!hidden.includes('xai-SECRET7890'));
  assert.ok(hidden.includes('[hidden key]'));
});

test('provider helpers', () => {
  assert.equal(Common.providerLabel('gemini'), 'Gemini');
  assert.equal(Common.providerLabel('grok'), 'Grok');
  assert.equal(Common.otherProvider('gemini'), 'grok');
  assert.equal(Common.otherProvider('grok'), 'gemini');
  assert.equal(Common.hasProviderKey({ geminiKey: 'x' }, 'gemini'), true);
  assert.equal(Common.hasProviderKey({ geminiKey: '' }, 'gemini'), false);
});

test('picks are stored under a site prefix', () => {
  assert.equal(Common.pickStorageKey('https://arena.ai/c'), 'site_https://arena.ai/c');
});

// ---------- Smart Helper settings ----------
test('the Smart Helper is off by default and a part needs the master switch', () => {
  const C = require('../../extension/common.js');
  const fresh = C.normalizeSettings({});
  assert.equal(fresh.helperOn, false, 'off by default');
  assert.equal(fresh.helperRoles, false);
  assert.equal(fresh.helperBest, false);
  assert.equal(fresh.helperStop, false);
  assert.equal(fresh.helperStopEvery, 1, 'check every round by default');
  assert.equal(fresh.helperMaxCalls, 30, '30 calls per run by default');
  assert.equal(fresh.goal, '');

  // A part saved as on while the master switch is off loads as off.
  const sneaky = C.normalizeSettings({ helperOn: false, helperStop: true, helperBest: true });
  assert.equal(sneaky.helperStop, false);
  assert.equal(sneaky.helperBest, false);

  const on = C.normalizeSettings({ helperOn: true, helperStop: true });
  assert.equal(on.helperStop, true);
});

test('the helper numbers are kept inside safe ranges', () => {
  const C = require('../../extension/common.js');
  assert.equal(C.normalizeSettings({ helperStopEvery: 0 }).helperStopEvery, 1);
  assert.equal(C.normalizeSettings({ helperStopEvery: 99 }).helperStopEvery, 20);
  assert.equal(C.normalizeSettings({ helperMaxCalls: -5 }).helperMaxCalls, 0);
  assert.equal(C.normalizeSettings({ helperMaxCalls: 9999 }).helperMaxCalls, 500);
  assert.equal(C.normalizeSettings({ helperMaxCalls: 'abc' }).helperMaxCalls, 30);
  assert.equal(C.normalizeSettings({ goal: 42 }).goal, '42');
});
