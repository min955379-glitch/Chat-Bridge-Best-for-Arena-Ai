// dev/tests/loop.test.js
// Runs the real background.js loop against two fake chat pages.
// This is the test that proves the acceptance check can work:
// "the two chats talk to each other for N rounds without me touching anything".
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorker } = require('../harness.js');
const { makePage } = require('../fake-page.js');

// Settings tuned for a fast test: 2 seconds of silence, 1 read per second.
const baseSettings = {
  rounds: 1,
  maxRounds: 100,
  silence: 2,
  timeout: 30,
  copyModeA: 'full',
  copyModeB: 'full',
  markerStart: 'START',
  markerEnd: 'END',
  prefix: '',
  suffix: '',
  stopIfSame: false,
  stopWord: '',
  mode: 'tab',
  provider: 'gemini',
  memory: 6
};

function setup(pages, settings, roles, store) {
  const worker = createWorker({ pollMs: 100, store: Object.assign({ settings: settings }, store || {}) });
  const ids = {};
  for (const [role, page] of Object.entries(pages)) {
    ids[role] = worker.chrome.__registerTab(page, { url: role === 'A' ? 'https://arena.ai/c/a1' : 'https://arena.ai/agent/b2' });
  }
  // Roles and picks are written straight to storage, as the popup would.
  worker.chrome.__store.roles = roles || { A: ids.A, B: ids.B };
  worker.chrome.__store['site_https://arena.ai/c'] = {
    input: { selector: 'textarea', kind: 'input' },
    send: { selector: '#send', kind: 'send' },
    reply: { selector: '.reply', kind: 'reply' }
  };
  worker.chrome.__store['site_https://arena.ai/agent'] = {
    input: { selector: 'textarea', kind: 'input' },
    send: { selector: '#send', kind: 'send' },
    reply: { selector: '.reply', kind: 'reply' }
  };
  return { worker, ids };
}

test('two tabs answer each other for the chosen number of rounds', { timeout: 60000 }, async () => {
  const pageA = makePage({
    replies: ['First message from A'],
    answerFor: (text, n) => 'A reply ' + n + ' to: ' + text.slice(0, 30)
  });
  const pageB = makePage({
    replies: ['B is ready'],
    answerFor: (text, n) => 'B reply ' + n + ' to: ' + text.slice(0, 30)
  });
  const { worker } = setup({ A: pageA, B: pageB }, Object.assign({}, baseSettings, { rounds: 2 }));

  const started = await worker.send({ type: 'start' });
  assert.equal(started.error, undefined, started.error);
  const status = await worker.waitForIdle(30000);

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  assert.match(status.text, /Finished all 2 rounds/);
  // Round 1 = A->B then B->A. Round 2 = A->B then B->A. Four sends.
  assert.equal(pageA.sends, 2);
  assert.equal(pageB.sends, 2);
  // A's first message went to B unchanged (no prefix in the settings).
  assert.equal(pageB.incoming[0], 'First message from A');
  // B's answer went back to A.
  assert.match(pageA.incoming[0], /^B reply 1 to: First message from A/);
});

test('the copy mode is used on each side', { timeout: 60000 }, async () => {
  const pageA = makePage({
    replies: ['thinking...\nSTART\nthe A message\nEND\ntrailing'],
    // Every later answer also carries markers, because A's copy mode is
    // "between markers" for the whole run.
    answerFor: () => 'thoughts\nSTART\nA says\nEND\nmore thoughts'
  });
  const pageB = makePage({
    replies: ['ready'],
    answerFor: (text) => 'B got: ' + text
  });
  const { worker } = setup({ A: pageA, B: pageB },
    Object.assign({}, baseSettings, { rounds: 1, copyModeA: 'markers' }));

  await worker.send({ type: 'start' });
  await worker.waitForIdle(30000);
  // The first message from A must be only the marked part.
  assert.equal(pageB.incoming[0], 'the A message');
});

test('prefix and suffix surround every forwarded message', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['hello from A'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['ready'], answerFor: () => 'b' });
  const { worker } = setup({ A: pageA, B: pageB }, Object.assign({}, baseSettings, {
    rounds: 1, prefix: 'Here is the other AI:', suffix: 'Please improve it.'
  }));

  await worker.send({ type: 'start' });
  await worker.waitForIdle(30000);
  assert.equal(pageB.incoming[0], 'Here is the other AI:\n\nhello from A\n\nPlease improve it.');
});

test('a missing pick is reported before anything is sent', async () => {
  const pageA = makePage({ replies: ['a'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['b'], answerFor: () => 'b' });
  const { worker } = setup({ A: pageA, B: pageB }, baseSettings);
  delete worker.chrome.__store['site_https://arena.ai/agent'].reply;

  const reply = await worker.send({ type: 'start' });
  assert.match(reply.error, /Tab B .*needs the AI reply picked/);
  assert.equal(pageA.sends, 0);
  assert.equal(pageB.sends, 0);
});

test('using the same tab for A and B is refused', async () => {
  const pageA = makePage({ replies: ['a'], answerFor: () => 'a' });
  const { worker, ids } = setup({ A: pageA, B: pageA }, baseSettings, null);
  worker.chrome.__store.roles = { A: ids.A, B: ids.A };

  const reply = await worker.send({ type: 'start' });
  assert.match(reply.error, /same tab/);
});

// Bug 4: a closed Tab B used to be skipped by the pick check, so the run
// started and then failed in the middle with a page error. It must be caught
// before anything is sent, with the same plain words as Tab A.
test('a closed Tab B is reported before the run starts', async () => {
  const pageA = makePage({ replies: ['hello'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['ready'], answerFor: () => 'b' });
  const { worker, ids } = setup({ A: pageA, B: pageB }, baseSettings);
  // Close Tab B by taking it out of the browser's tab list.
  worker.chrome.__tabs.delete(ids.B);

  const reply = await worker.send({ type: 'start' });
  assert.ok(reply.error, 'the run must not start');
  assert.match(reply.error, /Tab B is closed/);
  assert.match(reply.error, /Make this Tab B/);
  assert.equal(pageA.sends, 0, 'nothing is sent when a tab is closed');
  assert.equal(pageB.sends, 0);
});

// A closed Tab A keeps its old plain message.
test('a closed Tab A is reported before the run starts', async () => {
  const pageA = makePage({ replies: ['hello'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['ready'], answerFor: () => 'b' });
  const { worker, ids } = setup({ A: pageA, B: pageB }, baseSettings);
  worker.chrome.__tabs.delete(ids.A);

  const reply = await worker.send({ type: 'start' });
  assert.ok(reply.error, 'the run must not start');
  assert.match(reply.error, /Tab A is closed/);
  assert.match(reply.error, /Make this Tab A/);
  assert.equal(pageA.sends, 0);
  assert.equal(pageB.sends, 0);
});

// Bug 1: Tab B is a brand-new chat, so it has no AI reply at all yet. The
// loop must wait for it instead of failing with "the AI reply was not found".
test('a brand-new Tab B with no AI reply yet still works', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['What is 2 + 2?'], answerFor: () => 'a' });
  const pageB = makePage({ replies: [], answerFor: () => 'The answer is 4.' });
  // 2 seconds is the shortest silence the settings allow, and 1 read per
  // second in production; the test worker reads every 100 ms, so a reply
  // settles quickly. The run is over as soon as B's answer is read.
  const { worker } = setup({ A: pageA, B: pageB }, baseSettings);

  // start resolves when the run is over, so do not await it here.
  worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  // The first message reached the empty chat, and its answer came back to A.
  assert.equal(pageB.incoming.length, 1);
  assert.match(pageB.incoming[0], /What is 2 \+ 2\?/);
  assert.equal(pageA.incoming.length, 1);
  assert.match(pageA.incoming[0], /The answer is 4\./);
});

// Bug 2: some sites show the message you just pasted as the newest "reply",
// and keep showing it until the AI starts answering. That must not count as
// the AI answering: the loop must wait for the real answer instead of
// forwarding our own text back after 2 seconds of silence.
test('the pasted message showing as the last reply is not counted as an answer', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['start the loop'], answerFor: () => 'a' });
  // Tab B puts our pasted message at the end of its reply list, where the
  // reply selector points, and only later adds the AI's real answer.
  const pageB = { replies: [], incoming: [], sends: 0, __injected: false, __inject() {} };
  pageB.__handle = async (message) => {
    if (message.type === 'readReply') {
      const text = pageB.replies.length ? pageB.replies[pageB.replies.length - 1] : '';
      return { ok: true, count: pageB.replies.length, text: text, code: '' };
    }
    if (message.type === 'deliver') {
      pageB.sends += 1;
      pageB.incoming.push(message.text);
      pageB.replies.push(message.text); // the echo, shown as the newest reply
      // The AI takes longer than the 2 second silence window to start.
      setTimeout(() => pageB.replies.push('the real answer'), 3200);
      return { ok: true };
    }
    if (message.type === 'getSiteState') return { ok: true, picks: { input: true, send: true, reply: true } };
    return { error: 'unknown ' + message.type };
  };

  const { worker } = setup({ A: pageA, B: pageB }, baseSettings);
  const started = worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  await started;

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  assert.equal(pageA.incoming.length, 1);
  // A gets the AI's answer, not its own message coming back.
  assert.match(pageA.incoming[0], /the real answer/);
  assert.ok(!/start the loop/.test(pageA.incoming[0]),
    'A must not receive its own message back: ' + JSON.stringify(pageA.incoming));
});

// Bug 4: a closed Tab B used to be skipped by the pick check, so the run
// started and then failed in the middle with a page error. It must be caught
// before anything is sent, with the same plain words as Tab A.
test('a closed Tab B is reported before the run starts', async () => {
  const pageA = makePage({ replies: ['hello'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['ready'], answerFor: () => 'b' });
  const { worker, ids } = setup({ A: pageA, B: pageB }, baseSettings);
  // Close Tab B by taking it out of the browser's tab list.
  worker.chrome.__tabs.delete(ids.B);

  const reply = await worker.send({ type: 'start' });
  assert.ok(reply.error, 'the run must not start');
  assert.match(reply.error, /Tab B is closed/);
  assert.match(reply.error, /Make this Tab B/);
  assert.equal(pageA.sends, 0, 'nothing is sent when a tab is closed');
  assert.equal(pageB.sends, 0);
});

// A closed Tab A keeps its old plain message.
test('a closed Tab A is reported before the run starts', async () => {
  const pageA = makePage({ replies: ['hello'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['ready'], answerFor: () => 'b' });
  const { worker, ids } = setup({ A: pageA, B: pageB }, baseSettings);
  worker.chrome.__tabs.delete(ids.A);

  const reply = await worker.send({ type: 'start' });
  assert.ok(reply.error, 'the run must not start');
  assert.match(reply.error, /Tab A is closed/);
  assert.match(reply.error, /Make this Tab A/);
  assert.equal(pageA.sends, 0);
  assert.equal(pageB.sends, 0);
});

// Bug 1: Tab B is a brand-new chat, so it has no AI reply at all yet. The
// loop must wait for it instead of failing with "the AI reply was not found".
test('a brand-new Tab B with no AI reply yet still works', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['What is 2 + 2?'], answerFor: () => 'a' });
  const pageB = makePage({ replies: [], answerFor: () => 'The answer is 4.' });
  // 2 seconds is the shortest silence the settings allow, and 1 read per
  // second in production; the test worker reads every 100 ms, so a reply
  // settles quickly. The run is over as soon as B's answer is read.
  const { worker } = setup({ A: pageA, B: pageB }, baseSettings);

  // start resolves when the run is over, so do not await it here.
  worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  // The first message reached the empty chat, and its answer came back to A.
  assert.equal(pageB.incoming.length, 1);
  assert.match(pageB.incoming[0], /What is 2 \+ 2\?/);
  assert.equal(pageA.incoming.length, 1);
  assert.match(pageA.incoming[0], /The answer is 4\./);
});

// Bug 2: some sites show the message you just pasted as the newest "reply".
// That must not count as the AI answering, so the loop keeps waiting for the
// real answer instead of forwarding its own text back.
test('the pasted message showing up as the last reply is not an answer', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['start the loop'], answerFor: () => 'a' });
  // Tab B shows our pasted message back, then the AI's real answer.
  const pageB = makePage({ replies: [], answerFor: () => 'the real answer' });
  const deliver = pageB.__handle;
  pageB.__handle = async (message) => {
    const result = await deliver(message);
    if (message.type === 'deliver') {
      // The echo is in the reply list right away, so the first read after
      // pasting sees our own message as the newest reply.
      pageB.replies.push(message.text);
    }
    return result;
  };

  const { worker } = setup({ A: pageA, B: pageB }, baseSettings);
  const started = worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  await started;

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  // The loop waited for the answer after the echo: A got the answer, not
  // our own text coming back.
  assert.equal(pageA.incoming.length, 1);
  assert.match(pageA.incoming[0], /the real answer/);
  assert.ok(!/start the loop/.test(pageA.incoming[0]), 'A must not get its own message back');
});

test('stop stops the run quickly and says so', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['start'], answerFor: () => 'a' });
  // B never finishes typing, so the loop would wait forever without Stop.
  const pageB = makePage({
    replies: ['b'],
    neverFinish: true,
    answerFor: () => 'still typing'
  });
  const { worker } = setup({ A: pageA, B: pageB },
    Object.assign({}, baseSettings, { silence: 5, timeout: 60 }));

  worker.send({ type: 'start' });
  await worker.waitForStatus('waiting for B', 15000);
  await worker.send({ type: 'stop' });
  const status = await worker.waitForIdle(15000);
  assert.equal(status.tone, 'stopped');
  assert.match(status.text, /Stopped by you/);
});

test('a timeout is reported in plain words', { timeout: 70000 }, async () => {
  const pageA = makePage({ replies: ['start'], answerFor: () => 'a' });
  // B never starts a new reply: the page is broken.
  const pageB = { __handle: async () => ({ ok: true, count: 1, text: 'no answer coming' }), __inject() {} };
  // The timeout setting has a 30 second minimum, so this test really waits.
  const { worker } = setup({ A: pageA, B: pageB },
    Object.assign({}, baseSettings, { silence: 2, timeout: 30 }));

  worker.send({ type: 'start' });
  const status = await worker.waitForIdle(50000);
  assert.equal(status.tone, 'error', JSON.stringify(status));
  assert.match(status.text, /Timed out waiting for Tab B/);
});

test('stop when the reply contains a word', async () => {
  const pageA = makePage({ replies: ['go'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['ready'], answerFor: () => 'All done. DONE' });
  const { worker } = setup({ A: pageA, B: pageB },
    Object.assign({}, baseSettings, { rounds: 5, stopWord: 'DONE' }));

  await worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  assert.match(status.text, /contains "DONE"/);
  assert.equal(pageB.sends, 1, 'it must stop before the next round');
});

test('stop when the new reply is identical to the previous one', async () => {
  const pageA = makePage({ replies: ['go'], answerFor: () => 'the same answer every time' });
  const pageB = makePage({ replies: ['ready'], answerFor: () => 'the same answer every time' });
  const { worker } = setup({ A: pageA, B: pageB },
    Object.assign({}, baseSettings, { rounds: 5, stopIfSame: true }));

  await worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  assert.match(status.text, /identical to the previous one/);
});

test('a write to a tab that has no content script is retried after injecting it', async () => {
  const pageA = makePage({ replies: ['a'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['b'], answerFor: () => 'b' });
  pageB.__injected = false;
  // Simulate a page opened before the extension was installed.
  let loaded = false;
  const original = pageB.__handle;
  pageB.__handle = async (message) => {
    if (!loaded) throw new Error('Could not establish connection. Receiving end does not exist.');
    return original(message);
  };
  pageB.__inject = () => { loaded = true; };

  const { worker } = setup({ A: pageA, B: pageB }, baseSettings);
  await worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  assert.equal(status.tone, 'done', JSON.stringify(status));
  assert.equal(worker.chrome.__scriptCalls.length, 1);
  assert.equal(worker.chrome.__scriptCalls[0].files.join(','),
    'selectors.js,extract.js,common.js,content.js');
});

// ---------- Smart Helper: part 3, auto stop when done ----------
// A fake HTTP layer for the Smart Helper. It fills the same slot as the real
// fetch, so the whole api-client path (headers, fallback, parsing) really runs.
function fakeHelperApi(answers) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async fetch(url, options) {
      const body = JSON.parse(options.body || '{}');
      calls.push({
        url,
        headers: options.headers,
        question: body.contents ? body.contents[0].parts[0].text : body.messages[0].content,
        provider: url.includes('generativelanguage') ? 'gemini' : 'grok'
      });
      const list = Array.isArray(answers) ? answers : [answers];
      const answer = list[Math.min(index, list.length - 1)];
      index += 1;
      if (answer && answer.throwStatus) {
        return {
          status: answer.throwStatus,
          ok: false,
          async text() { return JSON.stringify({ error: { message: 'nope' } }); }
        };
      }
      const text = String(answer && answer.text !== undefined ? answer.text : answer);
      // Reply in the shape each provider really uses.
      const payload = url.includes('generativelanguage')
        ? { candidates: [{ content: { parts: [{ text: text }] } }] }
        : { choices: [{ message: { content: text } }] };
      return {
        status: 200,
        ok: true,
        async text() { return JSON.stringify(payload); }
      };
    }
  };
}

// The same two-page setup as above, plus the helper switched on.
function setupHelper(pages, settings, http) {
  // The worker normalizes its settings on every run, exactly like the popup
  // does, so the stored object must already be complete.
  const stored = require('../../extension/common.js').normalizeSettings(settings);
  const worker = createWorker({ pollMs: 100, store: { settings: stored }, fetch: http && http.fetch });
  const ids = {};
  for (const [role, page] of Object.entries(pages)) {
    ids[role] = worker.chrome.__registerTab(page, {
      url: role === 'A' ? 'https://arena.ai/c/a1' : 'https://arena.ai/agent/b2'
    });
  }
  worker.chrome.__store.roles = { A: ids.A, B: ids.B };
  worker.chrome.__store['site_https://arena.ai/c'] = {
    input: { selector: 'textarea', kind: 'input' },
    send: { selector: '#send', kind: 'send' },
    reply: { selector: '.reply', kind: 'reply' }
  };
  worker.chrome.__store['site_https://arena.ai/agent'] = {
    input: { selector: 'textarea', kind: 'input' },
    send: { selector: '#send', kind: 'send' },
    reply: { selector: '.reply', kind: 'reply' }
  };
  return { worker, ids };
}

const helperSettings = Object.assign({}, baseSettings, {
  rounds: 5,
  helperOn: true,
  helperStop: true,
  helperStopEvery: 1,
  helperMaxCalls: 30,
  goal: 'Build a to-do app.',
  provider: 'gemini',
  geminiKey: 'AIzaTEST',
  geminiModel: 'gemini-2.5-flash',
  grokKey: 'xai-TEST',
  grokModel: 'grok-4'
});

test('Smart Helper part 3: DONE after round 1 stops the loop and says why', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['Write the app.'], answerFor: () => 'A answer' });
  const pageB = makePage({ replies: ['Ready.'], answerFor: () => 'The app is finished.' });
  const api = fakeHelperApi('{"done":true,"reason":"the to-do app is finished and tested"}');
  const { worker } = setupHelper({ A: pageA, B: pageB }, helperSettings, api);

  worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  assert.match(status.text, /Stopped by the Smart Helper/);
  assert.match(status.text, /the to-do app is finished and tested/);
  assert.match(status.text, /\(Gemini\)/, 'the status names the provider that answered');
  assert.equal(pageA.sends, 1, 'only round 1 ran: A -> B once');
  assert.equal(pageB.sends, 1, 'and B answered once, so the round finished');
  assert.equal(api.calls.length, 1, 'one helper call, after the round');
  // The question carried the goal and the newest messages, not the whole chat.
  const question = api.calls[0].question;
  assert.match(question, /Build a to-do app\./);
  assert.match(question, /The app is finished\./);
  const log = worker.log().map((entry) => entry.text).join('\n');
  assert.match(log, /Smart Helper \(auto stop when done\) answered with Gemini/);
});

test('Smart Helper part 3: CONTINUE keeps the normal loop going', { timeout: 90000 }, async () => {
  const pageA = makePage({ replies: ['Write the app.'], answerFor: (text, n) => 'A step ' + n });
  const pageB = makePage({ replies: ['Ready.'], answerFor: (text, n) => 'B step ' + n });
  const api = fakeHelperApi([
    '{"done":false,"reason":"the delete button is missing"}',
    '{"done":false,"reason":"still needs tests"}'
  ]);
  const settings = Object.assign({}, helperSettings, { rounds: 2 });
  const { worker } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const started = worker.send({ type: 'start' });
  const status = await worker.waitForIdle(45000);
  await started;

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  assert.match(status.text, /Finished all 2 rounds/);
  assert.equal(pageA.sends, 2, 'both rounds really ran');
  assert.equal(api.calls.length, 2, 'one check after each round');
  const log = worker.log().map((entry) => entry.text).join('\n');
  assert.match(log, /not finished yet — the delete button is missing/);
});

test('Smart Helper part 3: a failed helper call is logged and the loop carries on', { timeout: 90000 }, async () => {
  const pageA = makePage({ replies: ['Write the app.'], answerFor: (text, n) => 'A step ' + n });
  const pageB = makePage({ replies: ['Ready.'], answerFor: (text, n) => 'B step ' + n });
  const api = fakeHelperApi({ throwStatus: 500 });
  const settings = Object.assign({}, helperSettings, { rounds: 2 });
  const { worker } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const started = worker.send({ type: 'start' });
  const status = await worker.waitForIdle(45000);
  await started;

  assert.equal(status.tone, 'done', 'a helper failure never crashes the run');
  assert.match(status.text, /Finished all 2 rounds/);
  assert.ok(api.calls.length >= 2, 'the helper really tried each round');
  const log = worker.log().map((entry) => entry.text).join('\n');
  assert.match(log, /could not answer/);
  assert.match(log, /The normal loop carries on/);
});

test('Smart Helper part 3: only every N rounds is checked', { timeout: 90000 }, async () => {
  const pageA = makePage({ replies: ['Write the app.'], answerFor: (text, n) => 'A step ' + n });
  const pageB = makePage({ replies: ['Ready.'], answerFor: (text, n) => 'B step ' + n });
  const api = fakeHelperApi('{"done":false,"reason":"not yet"}');
  const settings = Object.assign({}, helperSettings, { rounds: 3, helperStopEvery: 2 });
  const { worker } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const started = worker.send({ type: 'start' });
  await worker.waitForIdle(60000);
  await started;

  assert.equal(api.calls.length, 1, 'only round 2 was checked, round 3 comes after the cap');
});

test('Smart Helper off and no keys: tab to tab still works exactly as before', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['Hello.'], answerFor: () => 'A answer' });
  const pageB = makePage({ replies: ['Ready.'], answerFor: () => 'B answer' });
  const api = fakeHelperApi({ text: '{"done":true,"reason":"should never be asked"}', });
  // The master switch on, every part off, and no keys at all.
  const settings = Object.assign({}, helperSettings, {
    rounds: 1,
    helperOn: true,
    helperStop: false,
    helperRoles: false,
    helperBest: false,
    geminiKey: '',
    grokKey: ''
  });
  const { worker } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const started = worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  await started;

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  assert.match(status.text, /Finished all 1 round/);
  assert.equal(api.calls.length, 0, 'no helper call was made');
  assert.equal(pageA.sends, 1);
  assert.equal(pageB.sends, 1);
});

test('a reply that starts empty is not treated as finished', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['start'], answerFor: () => 'a' });
  // The site adds an empty reply element immediately, then fills it slowly.
  const pageB = makePage({
    replies: ['ready'],
    replyDelay: 4,
    steps: 3,
    answerFor: () => 'the full answer'
  });
  const { worker } = setup({ A: pageA, B: pageB },
    Object.assign({}, baseSettings, { silence: 2 }));

  await worker.send({ type: 'start' });
  const status = await worker.waitForIdle(40000);
  assert.equal(status.tone, 'done', JSON.stringify(status));
  // Tab A received the COMPLETE answer, not a half-written one.
  assert.equal(pageA.incoming[0], 'the full answer');
});

test('API mode: the API answers and Tab A answers back', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify({ candidates: [{ content: { parts: [{ text: 'API says hi' }] } }] });
      }
    };
  };
  const pageA = makePage({ replies: ['question from A'], answerFor: (text) => 'A answers: ' + text });
  const worker = createWorker({
    pollMs: 100,
    fetch: fakeFetch,
    store: {
      settings: Object.assign({}, baseSettings, {
        mode: 'api', rounds: 1, geminiKey: 'AIzaKEY', grokKey: 'xai-KEY'
      })
    }
  });
  const idA = worker.chrome.__registerTab(pageA, { url: 'https://arena.ai/c/a1' });
  worker.chrome.__store.roles = { A: idA, B: null };
  worker.chrome.__store['site_https://arena.ai/c'] = {
    input: { selector: 'textarea', kind: 'input' },
    send: { selector: '#send', kind: 'send' },
    reply: { selector: '.reply', kind: 'reply' }
  };

  const started = await worker.send({ type: 'start' });
  assert.equal(started.error, undefined, started.error);
  const status = await worker.waitForIdle(30000);
  assert.equal(status.tone, 'done', JSON.stringify(status));

  // The API got the first message from Tab A.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(calls[0].body.contents[0].parts[0].text, 'question from A');
  // The API answer was pasted into Tab A.
  assert.match(pageA.incoming[0], /API says hi/);
});

test('API mode: the status line names the provider that answered', async () => {
  const fakeFetch = async () => ({
    status: 200,
    ok: true,
    async text() {
      return JSON.stringify({ choices: [{ message: { content: 'grok answer' } }] });
    }
  });
  const pageA = makePage({ replies: ['q'], answerFor: () => 'a' });
  const worker = createWorker({
    pollMs: 100,
    fetch: fakeFetch,
    store: {
      settings: Object.assign({}, baseSettings, {
        mode: 'api', rounds: 1, provider: 'grok', geminiKey: '', grokKey: 'xai-KEY'
      })
    }
  });
  const idA = worker.chrome.__registerTab(pageA, { url: 'https://arena.ai/c/a1' });
  worker.chrome.__store.roles = { A: idA };
  worker.chrome.__store['site_https://arena.ai/c'] = {
    input: { selector: 'textarea', kind: 'input' },
    send: { selector: '#send', kind: 'send' },
    reply: { selector: '.reply', kind: 'reply' }
  };

  await worker.send({ type: 'start' });
  await worker.waitForIdle(30000);
  const log = worker.log().map((entry) => entry.text).join('\n');
  // The log must name the provider that answered, as the brief asks.
  assert.match(log, /Grok answered/);
  assert.match(log, /Grok as the main provider/);
  assert.match(log, /Round 1 of 1 finished \(Grok\)/);
});

test('API memory starts with a user turn and stays short', { timeout: 90000 }, async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify({ candidates: [{ content: { parts: [{ text: 'api answer' }] } }] });
      }
    };
  };
  const pageA = makePage({ replies: ['first question'], answerFor: (text, n) => 'tab answer ' + n });
  const worker = createWorker({
    pollMs: 100,
    fetch: fakeFetch,
    store: {
      settings: Object.assign({}, baseSettings, {
        mode: 'api', rounds: 3, memory: 4, geminiKey: 'AIzaKEY', grokKey: 'xai-KEY'
      })
    }
  });
  const idA = worker.chrome.__registerTab(pageA, { url: 'https://arena.ai/c/a1' });
  worker.chrome.__store.roles = { A: idA };
  worker.chrome.__store['site_https://arena.ai/c'] = {
    input: { selector: 'textarea' }, reply: { selector: '.reply' }
  };

  await worker.send({ type: 'start' });
  await worker.waitForIdle(60000);
  assert.equal(calls.length, 3, 'one API call per round');

  for (const body of calls) {
    // Gemini requires the conversation to start with the user's turn.
    assert.equal(body.contents[0].role, 'user',
      'memory must start with a user turn: ' + JSON.stringify(body.contents.map((c) => c.role)));
    // The first call has 1 message, later calls grow but stop at the limit.
    assert.ok(body.contents.length <= 4, 'memory must respect the limit');
    // Gemini calls the assistant role "model".
    const roles = body.contents.map((c) => c.role);
    for (let i = 1; i < roles.length; i++) {
      assert.notEqual(roles[i], roles[i - 1], 'turns must alternate: ' + roles.join(','));
    }
  }
  // Later calls carry the earlier conversation.
  assert.ok(calls[2].contents.length >= 3, 'context should grow: ' + calls[2].contents.length);
});

test('API mode without any key refuses to start with a clear message', async () => {
  const pageA = makePage({ replies: ['q'], answerFor: () => 'a' });
  const worker = createWorker({
    store: { settings: Object.assign({}, baseSettings, { mode: 'api', geminiKey: '', grokKey: '' }) }
  });
  const idA = worker.chrome.__registerTab(pageA, { url: 'https://arena.ai/c/a1' });
  worker.chrome.__store.roles = { A: idA };
  worker.chrome.__store['site_https://arena.ai/c'] = {
    input: { selector: 'textarea' }, reply: { selector: '.reply' }
  };
  const reply = await worker.send({ type: 'start' });
  assert.match(reply.error, /API key/);
});

test('rounds are limited by the safety cap', async () => {
  const pageA = makePage({ replies: ['a'], answerFor: () => 'a' });
  const pageB = makePage({ replies: ['b'], answerFor: () => 'b' });
  const { worker } = setup({ A: pageA, B: pageB },
    Object.assign({}, baseSettings, { rounds: 7, maxRounds: 2 }));
  await worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  assert.match(status.text, /Finished all 2 rounds/);
});

// ---------- Smart Helper: part 1, auto detect brain and worker ----------
// The fake page needs to answer the new "readLastUser" message.
function withUserMessages(page, texts) {
  const handle = page.__handle;
  page.__handle = async (message) => {
    if (message.type === 'readLastUser') {
      const text = texts.length ? texts[texts.length - 1] : '';
      return { ok: true, text };
    }
    return handle(message);
  };
  return page;
}

test('Smart Helper part 1: the brain becomes Tab A and the worker Tab B', async () => {
  const pageA = withUserMessages(
    makePage({ replies: ['Here is the code for step 1.'], answerFor: () => 'x' }), ['Do step 1 now.']);
  const pageB = withUserMessages(
    makePage({ replies: ['Here is the plan, step by step.'], answerFor: () => 'y' }), ['Plan the work.']);
  // The API says B is the brain.
  const api = fakeHelperApi('{"brain":"B","confidence":"high","reason":"B writes the plan"}');
  const settings = Object.assign({}, helperSettings, { helperStop: false, helperRoles: true });
  const { worker, ids } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const reply = await worker.send({ type: 'detectRoles' });
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.equal(reply.brain, 'B');
  assert.match(reply.message, /looks like the brain/);
  // The roles were really swapped: the old B is now Tab A.
  assert.equal(worker.chrome.__store.roles.A, ids.B);
  assert.equal(worker.chrome.__store.roles.B, ids.A);
  // Both tabs were asked for their newest user message.
  const question = api.calls[0].question;
  assert.match(question, /Plan the work\./);
  assert.match(question, /Do step 1 now\./);
  assert.match(question, /Here is the plan, step by step\./);
  const log = worker.log().map((entry) => entry.text).join('\n');
  assert.match(log, /Smart Helper set the roles/);
});

test('Smart Helper part 1: an unclear answer changes nothing', async () => {
  const pageA = withUserMessages(makePage({ replies: ['code'], answerFor: () => 'x' }), ['step 1']);
  const pageB = withUserMessages(makePage({ replies: ['plan'], answerFor: () => 'y' }), ['plan it']);
  const api = fakeHelperApi('I cannot tell these two apart.');
  const settings = Object.assign({}, helperSettings, { helperStop: false, helperRoles: true });
  const { worker, ids } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const reply = await worker.send({ type: 'detectRoles' });
  assert.ok(reply.error, 'the popup is told');
  assert.match(reply.error, /could not tell which window is the brain/);
  assert.match(reply.error, /Nothing was changed/);
  assert.equal(worker.chrome.__store.roles.A, ids.A, 'Tab A is still the same tab');
  assert.equal(worker.chrome.__store.roles.B, ids.B, 'Tab B is still the same tab');
});

test('Smart Helper part 1: a failed call changes nothing and explains why', async () => {
  const pageA = withUserMessages(makePage({ replies: ['code'], answerFor: () => 'x' }), ['step 1']);
  const pageB = withUserMessages(makePage({ replies: ['plan'], answerFor: () => 'y' }), ['plan it']);
  const api = fakeHelperApi({ throwStatus: 500 });
  const settings = Object.assign({}, helperSettings, { helperStop: false, helperRoles: true });
  const { worker, ids } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const reply = await worker.send({ type: 'detectRoles' });
  assert.ok(reply.error);
  assert.match(reply.error, /Nothing was changed/);
  assert.equal(worker.chrome.__store.roles.A, ids.A);
  assert.equal(worker.chrome.__store.roles.B, ids.B);
});

test('Smart Helper part 1: detecting needs both tabs chosen', async () => {
  const pageA = withUserMessages(makePage({ replies: ['code'], answerFor: () => 'x' }), ['step 1']);
  const api = fakeHelperApi('{"brain":"A"}');
  const settings = Object.assign({}, helperSettings, { helperStop: false, helperRoles: true });
  const { worker } = setupHelper({ A: pageA }, settings, api);
  worker.chrome.__store.roles = { A: worker.chrome.__store.roles.A, B: null };

  const reply = await worker.send({ type: 'detectRoles' });
  assert.ok(reply.error);
  assert.match(reply.error, /Choose Tab A and Tab B first/);
  assert.equal(api.calls.length, 0, 'no API call without two tabs');
});

// ---------- Smart Helper: part 2, pick the best answer card ----------
// A fake page that shows two answer cards for the newest turn, like Arena
// battle mode. The first card is the weak one, the second is complete.
function battlePage(options) {
  const opts = options || {};
  const page = {
    replies: ['ready'],
    incoming: [],
    sends: 0,
    cards: ['I think maybe add them?', 'function add(a, b) { return a + b; } /* complete */'],
    __injected: false,
    __inject() {}
  };
  page.__handle = async (message) => {
    if (message.type === 'readReply') {
      const last = page.replies[page.replies.length - 1] || '';
      return { ok: true, count: page.replies.length, text: last, code: '' };
    }
    if (message.type === 'readReplyGroup') {
      return {
        ok: true,
        count: page.cards.length,
        cards: page.cards.map((text) => ({ text, code: '' }))
      };
    }
    if (message.type === 'readLastUser') return { ok: true, text: '' };
    if (message.type === 'deliver') {
      page.sends += 1;
      page.incoming.push(message.text);
      // The newest reply becomes card 2: the one a normal reader would use.
      page.replies.push(page.cards[page.cards.length - 1]);
      return { ok: true };
    }
    if (message.type === 'getSiteState') return { ok: true, picks: { input: true, send: true, reply: true } };
    return { error: 'unknown ' + message.type };
  };
  return page;
}

test('Smart Helper part 2: the best card is forwarded, not just the last one', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['Write a function.'], answerFor: () => 'A answer' });
  const pageB = battlePage();
  // The API says card 2 is the best one for the goal.
  const api = fakeHelperApi('{"best":2,"reason":"card 2 has the complete function"}');
  const settings = Object.assign({}, helperSettings, {
    rounds: 1, helperStop: false, helperBest: true, goal: 'Build a to-do app.'
  });
  const { worker } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const started = worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  await started;

  assert.equal(status.tone, 'done', 'status was: ' + JSON.stringify(status));
  // The chosen card (2) was forwarded back to Tab A.
  assert.equal(pageA.incoming.length, 1);
  assert.match(pageA.incoming[0], /function add\(a, b\)/, 'the complete card was sent');
  assert.ok(!/I think maybe add them/.test(pageA.incoming[0]), 'the weak card was not sent');
  // The log says which card and why.
  const log = worker.log().map((entry) => entry.text).join('\n');
  assert.match(log, /chose card 2 of 2/);
  assert.match(log, /complete function/);
  // Auto stop was not switched on here, so it never asked.
  assert.ok(!/auto stop when done\) answered/.test(log));
});

test('Smart Helper part 2: with a single answer the API is never asked', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['Write a function.'], answerFor: () => 'A answer' });
  const pageB = battlePage();
  pageB.cards = ['the only answer'];
  const api = fakeHelperApi('{"best":1,"reason":"only one"}');
  const settings = Object.assign({}, helperSettings, {
    rounds: 1, helperStop: false, helperBest: true, goal: 'x'
  });
  const { worker } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const started = worker.send({ type: 'start' });
  await worker.waitForIdle(30000);
  await started;

  assert.equal(api.calls.length, 0, 'no API call for a single answer');
  assert.match(pageA.incoming[0], /the only answer/);
});

test('Smart Helper part 2: a failed choice uses the newest answer and carries on', { timeout: 60000 }, async () => {
  const pageA = makePage({ replies: ['Write a function.'], answerFor: () => 'A answer' });
  const pageB = battlePage();
  const api = fakeHelperApi({ throwStatus: 500 });
  const settings = Object.assign({}, helperSettings, {
    rounds: 1, helperStop: false, helperBest: true, goal: 'x'
  });
  const { worker } = setupHelper({ A: pageA, B: pageB }, settings, api);

  const started = worker.send({ type: 'start' });
  const status = await worker.waitForIdle(30000);
  await started;

  assert.equal(status.tone, 'done', 'a failed choice never stops the run');
  // The normal reader's answer (the last card) was used instead.
  assert.match(pageA.incoming[0], /function add\(a, b\)/);
  const log = worker.log().map((entry) => entry.text).join('\n');
  assert.match(log, /The newest answer is used/);
});
