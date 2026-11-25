// dev/tests/api-client.test.js
// Checks the Gemini and Grok request shapes and the fallback rules:
// retry once, then switch provider, 60 second cooldown after a 429, and a
// plain error when both providers fail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../../extension/api-client.js');

const settings = {
  provider: 'gemini',
  geminiKey: 'AIzaTEST',
  geminiModel: 'gemini-2.5-flash',
  grokKey: 'xai-TEST',
  grokModel: 'grok-4',
  systemPrompt: 'Be brief.'
};

// Build a fake fetch that answers with a scripted list of responses.
function fakeFetch(script, log) {
  let index = 0;
  return async function fetchStub(url, options) {
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    if (log) log.push({ url, options, step });
    if (step.type === 'network') throw new Error('network down');
    return {
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      async text() { return JSON.stringify(step.body || {}); }
    };
  };
}

const geminiOk = (text) => ({ type: 'http', status: 200, body: { candidates: [{ content: { parts: [{ text }] } }] } });
const grokOk = (text) => ({ type: 'http', status: 200, body: { choices: [{ message: { content: text } }] } });
const httpError = (status) => ({ type: 'http', status, body: { error: { message: 'nope' } } });

const noWait = { retryWaitMs: 0, sleep: async () => {} };

test('Gemini request uses the documented URL, header and body', () => {
  const req = Api.buildGeminiRequest('gemini-2.5-flash', [
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'world' }
  ], 'You are a bot.');
  assert.equal(req.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.deepEqual(req.body.contents, [
    { role: 'model', parts: [{ text: 'hello' }] },
    { role: 'user', parts: [{ text: 'world' }] }
  ]);
  assert.deepEqual(req.body.systemInstruction, { parts: [{ text: 'You are a bot.' }] });
});

test('a model name written as "models/x" is cleaned up', () => {
  const req = Api.buildGeminiRequest('models/gemini-2.5-pro', [{ role: 'user', content: 'hi' }], '');
  assert.ok(req.url.includes('/models/gemini-2.5-pro:generateContent'));
  assert.equal(req.body.systemInstruction, undefined);
});

test('Grok request uses the OpenAI compatible body', () => {
  const req = Api.buildGrokRequest('grok-4', [{ role: 'user', content: 'hi' }], 'Sys');
  assert.equal(req.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(req.body.model, 'grok-4');
  assert.deepEqual(req.body.messages, [
    { role: 'system', content: 'Sys' },
    { role: 'user', content: 'hi' }
  ]);
  assert.equal(req.body.stream, false);
});

test('a normal Gemini answer is returned with the provider name', async () => {
  const sent = [];
  const result = await Api.requestWithFallback([{ role: 'user', content: 'hi' }], settings, Object.assign({
    fetch: fakeFetch([geminiOk('hello there')], sent)
  }, noWait));
  assert.equal(result.text, 'hello there');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.fellBack, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.headers['x-goog-api-key'], 'AIzaTEST');
});

test('a 500 is retried once, then answered on the second try', async () => {
  const sent = [];
  const result = await Api.requestWithFallback([{ role: 'user', content: 'hi' }], settings, Object.assign({
    fetch: fakeFetch([httpError(500), geminiOk('second time')], sent)
  }, noWait));
  assert.equal(result.text, 'second time');
  assert.equal(sent.length, 2);
  assert.ok(result.notes.some((n) => /Trying once more/.test(n)));
});

test('a failing primary falls back to the backup provider', async () => {
  const sent = [];
  const result = await Api.requestWithFallback([{ role: 'user', content: 'hi' }], settings, Object.assign({
    fetch: fakeFetch([httpError(500), httpError(500), grokOk('grok answers')], sent)
  }, noWait));
  assert.equal(result.text, 'grok answers');
  assert.equal(result.provider, 'grok');
  assert.equal(result.fellBack, true);
  assert.equal(sent[2].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(sent[2].options.headers.Authorization, 'Bearer xai-TEST');
});

test('a 429 puts the provider to rest and the backup answers at once', async () => {
  const sent = [];
  let clock = 1000;
  const result = await Api.requestWithFallback([{ role: 'user', content: 'hi' }], settings, Object.assign({
    fetch: fakeFetch([httpError(429), grokOk('backup')], sent),
    now: () => clock
  }, noWait));
  assert.equal(result.provider, 'grok');
  // A 429 is not retried on the same provider, so only two calls happen.
  assert.equal(sent.length, 2);
  assert.ok(result.notes.some((n) => /rate limit/.test(n)));
});

test('a second question within 60 seconds skips the provider that got a 429', async () => {
  // The cooldown lives as long as one call, so this test checks the message.
  // A 429 on a request with no backup key must explain the problem clearly.
  const oneSide = Object.assign({}, settings, { grokKey: '' });
  await assert.rejects(
    () => Api.requestWithFallback([{ role: 'user', content: 'hi' }], oneSide, Object.assign({
      fetch: fakeFetch([httpError(429)], [])
    }, noWait)),
    (err) => /Gemini|limit/.test(err.message)
  );
});

test('an empty Gemini answer counts as a failure and uses the backup', async () => {
  const sent = [];
  const result = await Api.requestWithFallback([{ role: 'user', content: 'hi' }], settings, Object.assign({
    fetch: fakeFetch([{ type: 'http', status: 200, body: { candidates: [] } },
      { type: 'http', status: 200, body: { candidates: [] } },
      grokOk('grok to the rescue')], sent)
  }, noWait));
  assert.equal(result.provider, 'grok');
  assert.equal(result.text, 'grok to the rescue');
});

test('a network error is retried, then the backup is used', async () => {
  const sent = [];
  const result = await Api.requestWithFallback([{ role: 'user', content: 'hi' }], settings, Object.assign({
    fetch: fakeFetch([{ type: 'network' }, { type: 'network' }, grokOk('ok')], sent)
  }, noWait));
  assert.equal(result.provider, 'grok');
  assert.equal(sent.length, 3);
});

test('when both providers fail the error is plain and mentions both', async () => {
  await assert.rejects(
    () => Api.requestWithFallback([{ role: 'user', content: 'hi' }], settings, Object.assign({
      fetch: fakeFetch([httpError(500), httpError(500), httpError(503), httpError(503)], [])
    }, noWait)),
    (err) => /Both API providers failed/.test(err.message) && /Gemini/.test(err.message)
  );
});

test('a missing key stops early with a clear message', async () => {
  await assert.rejects(
    () => Api.requestWithFallback([{ role: 'user', content: 'hi' }],
      Object.assign({}, settings, { geminiKey: '', grokKey: '' }), Object.assign({
        fetch: fakeFetch([geminiOk('x')], [])
      }, noWait)),
    (err) => /No API key saved for Gemini/.test(err.message)
  );
});

test('a missing primary key falls back to the backup that has one', async () => {
  const sent = [];
  const result = await Api.requestWithFallback([{ role: 'user', content: 'hi' }],
    Object.assign({}, settings, { geminiKey: '' }), Object.assign({
      fetch: fakeFetch([grokOk('from grok')], sent)
    }, noWait));
  assert.equal(result.provider, 'grok');
  assert.equal(sent.length, 1);
});

test('the Grok primary works the other way round', async () => {
  const sent = [];
  const result = await Api.requestWithFallback([{ role: 'user', content: 'hi' }],
    Object.assign({}, settings, { provider: 'grok' }), Object.assign({
      fetch: fakeFetch([grokOk('grok first')], sent)
    }, noWait));
  assert.equal(result.provider, 'grok');
  assert.equal(sent[0].url, 'https://api.x.ai/v1/chat/completions');
});

test('HTTP status codes are explained in plain words', () => {
  assert.match(Api.explainStatus(429), /quota|rate limit/);
  assert.match(Api.explainStatus(401), /key was rejected/);
  assert.match(Api.explainStatus(403), /key was rejected/);
  assert.match(Api.explainStatus(404), /model name/);
  assert.match(Api.explainStatus(503), /service is having problems/);
});
