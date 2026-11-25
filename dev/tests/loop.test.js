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
