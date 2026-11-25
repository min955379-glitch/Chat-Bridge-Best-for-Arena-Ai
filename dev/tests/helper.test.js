// dev/tests/helper.test.js
// Checks the Smart Helper module on its own, with a fake API:
// the switch rules, the call budget, the three prompts and their parsers,
// and the promise that a failed helper call never throws.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Helper = require('../../extension/helper.js');

const baseSettings = {
  provider: 'gemini',
  geminiKey: 'AIzaTEST',
  geminiModel: 'gemini-2.5-flash',
  grokKey: 'xai-TEST',
  grokModel: 'grok-4',
  helperOn: true,
  helperRoles: false,
  helperBest: false,
  helperStop: false,
  helperStopEvery: 1,
  helperMaxCalls: 30,
  goal: 'Build a to-do app.'
};

function settingsWith(extra) {
  return Object.assign({}, baseSettings, extra || {});
}

// A fake api-client that records every request and answers with a script.
function fakeApi(answers) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async requestWithFallback(messages, settings, deps) {
      calls.push({ messages, settings, deps });
      const script = Array.isArray(answers) ? answers : [answers];
      const answer = script[Math.min(index, script.length - 1)];
      index += 1;
      if (answer && answer.throw) throw new Error(answer.throw);
      return {
        text: answer && answer.text !== undefined ? answer.text : '',
        provider: (answer && answer.provider) || settings.provider,
        fellBack: false,
        notes: (answer && answer.notes) || []
      };
    }
  };
}

// ---------- the switches ----------
test('nothing runs unless the master switch and the part are both on', () => {
  assert.equal(Helper.on(settingsWith({ helperOn: false, helperStop: true }), 'stop'), false,
    'the master switch has the last word');
  assert.equal(Helper.on(settingsWith({ helperOn: true, helperStop: false }), 'stop'), false);
  assert.equal(Helper.on(settingsWith({ helperOn: true, helperStop: true }), 'stop'), true);
  assert.equal(Helper.on(settingsWith({ helperOn: true, helperRoles: true }), 'roles'), true);
  assert.equal(Helper.on(settingsWith({ helperOn: true, helperBest: true }), 'best'), true);
  assert.equal(Helper.anyPartOn(settingsWith({ helperOn: true })), false);
  assert.equal(Helper.anyPartOn(settingsWith({ helperOn: true, helperBest: true })), true);
});

test('the default limit is 30 calls and a bad number falls back to it', () => {
  assert.equal(Helper.maxCalls({}), 30);
  assert.equal(Helper.maxCalls({ helperMaxCalls: '' }), 30);
  assert.equal(Helper.maxCalls({ helperMaxCalls: 'nonsense' }), 30);
  assert.equal(Helper.maxCalls({ helperMaxCalls: 5 }), 5);
  assert.equal(Helper.maxCalls({ helperMaxCalls: -3 }), 0, 'never negative');
  assert.equal(Helper.maxCalls({ helperMaxCalls: 99999 }), 500, 'never silly');
});

// ---------- the call budget ----------
test('the budget hands out exactly the calls it allows, then refuses', () => {
  const budget = Helper.createBudget(2);
  assert.equal(budget.take(), true);
  assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  assert.equal(budget.used, 2);
  assert.equal(budget.left(), 0);
});

test('running out of calls skips the helper instead of failing', async () => {
  const api = fakeApi({ text: '{"done":true,"reason":"finished"}' });
  const budget = Helper.createBudget(1);
  const deps = { api, settings: settingsWith({ helperStop: true }), budget };
  const first = await Helper.shouldStop({ goal: 'x', round: 1, messages: [] }, deps);
  assert.equal(first.checked, true);
  const second = await Helper.shouldStop({ goal: 'x', round: 2, messages: [] }, deps);
  assert.equal(second.checked, false);
  assert.equal(second.skipped, true);
  assert.match(second.why, /used all its calls/);
  assert.equal(api.calls.length, 1, 'the second call never reached the API');
});

// ---------- part 3: auto stop ----------
test('auto stop asks DONE or CONTINUE and stops only on DONE', async () => {
  const api = fakeApi({ text: '{"done":true,"reason":"the app is finished and tested"}', provider: 'grok' });
  const result = await Helper.shouldStop(
    { goal: 'Build a to-do app.', round: 1, messages: [{ who: 'Tab A', text: 'Here is the finished app.' }] },
    { api, settings: settingsWith({ helperStop: true }), budget: Helper.createBudget(30) }
  );
  assert.equal(result.checked, true);
  assert.equal(result.done, true);
  assert.equal(result.provider, 'Grok');
  assert.match(result.stopText, /^Stopped by the Smart Helper: the app is finished and tested \(Grok\)$/);
  // The question carries the goal and the latest message, and says what to answer.
  const question = api.calls[0].messages[0].content;
  assert.match(question, /Build a to-do app\./);
  assert.match(question, /Here is the finished app\./);
  assert.match(question, /DONE or CONTINUE/);
});

test('a CONTINUE answer keeps the loop going and logs the reason', async () => {
  const api = fakeApi({ text: '{"done":false,"reason":"the delete button is missing"}', provider: 'gemini' });
  const result = await Helper.shouldStop(
    { goal: 'Build a to-do app.', round: 1, messages: [] },
    { api, settings: settingsWith({ helperStop: true }), budget: Helper.createBudget(30) }
  );
  assert.equal(result.done, false);
  assert.match(result.log, /not finished yet/);
  assert.match(result.log, /delete button/);
  assert.equal(result.stopText, undefined);
});

test('a plain DONE or CONTINUE answer is understood too', () => {
  assert.equal(Helper.parseStopAnswer('DONE: everything works.').done, true);
  assert.equal(Helper.parseStopAnswer('CONTINUE: still writing tests.').done, false);
  // A muddled answer is never treated as finished: the loop keeps going.
  assert.equal(Helper.parseStopAnswer('I am not sure.').ok, false);
  assert.equal(Helper.parseStopAnswer('').ok, false);
});

test('auto stop is skipped when the goal is empty, off, or not this round', async () => {
  const api = fakeApi({ text: '{"done":true,"reason":"x"}' });
  const deps = { api, settings: settingsWith({ helperStop: true }), budget: Helper.createBudget(30) };
  assert.equal((await Helper.shouldStop({ goal: '   ', round: 1, messages: [] }, deps)).checked, false);
  const off = { api, settings: settingsWith({ helperStop: false }), budget: Helper.createBudget(30) };
  assert.equal((await Helper.shouldStop({ goal: 'x', round: 1, messages: [] }, off)).checked, false);
  // Every 3 rounds: rounds 1 and 2 are skipped without a call.
  const every3 = {
    api,
    settings: settingsWith({ helperStop: true, helperStopEvery: 3 }),
    budget: Helper.createBudget(30)
  };
  assert.equal((await Helper.shouldStop({ goal: 'x', round: 2, messages: [] }, every3)).checked, false);
  assert.equal(api.calls.length, 0, 'no call on a round that is not checked');
  assert.equal(Helper.stopCheckDue(settingsWith({ helperStop: true, helperStopEvery: 3 }), 3), true);
  assert.equal(Helper.stopCheckDue(settingsWith({ helperStop: true, helperStopEvery: 3 }), 4), false);
});

test('only the last few messages are sent, never the whole chat', async () => {
  const api = fakeApi({ text: '{"done":false,"reason":"still going"}' });
  const many = [];
  for (let i = 1; i <= 40; i++) many.push({ who: 'Tab A', text: 'message number ' + i });
  await Helper.shouldStop(
    { goal: 'x', round: 1, messages: many },
    { api, settings: settingsWith({ helperStop: true }), budget: Helper.createBudget(30) }
  );
  const question = api.calls[0].messages[0].content;
  assert.match(question, /message number 40/, 'the newest message is sent');
  assert.ok(!/message number 1\b/.test(question), 'the oldest messages are not sent');
  assert.ok(question.length < 6000, 'the question stays small: ' + question.length);
});

test('a very long message is cut and says so', () => {
  const long = 'word '.repeat(2000);
  const cut = Helper.clip(long, 100);
  assert.ok(cut.length < 200);
  assert.match(cut, /cut to keep the message short/);
});

// ---------- parts 1 and 2: parsers ----------
test('the role answer is read strictly and never guessed', () => {
  assert.deepEqual(
    Helper.parseRoleAnswer('{"brain":"B","confidence":"high","reason":"B plans the steps"}').brain, 'B');
  assert.equal(Helper.parseRoleAnswer('{"brain":"A", "confidence":"low"}').worker, 'B');
  // JSON inside a code fence is still fine.
  assert.equal(Helper.parseRoleAnswer('```json\n{"brain":"A"}\n```').brain, 'A');
  // Anything unclear changes nothing.
  assert.equal(Helper.parseRoleAnswer('I think the left one?').ok, false);
  assert.equal(Helper.parseRoleAnswer('{"brain":"maybe"}').ok, false);
  assert.equal(Helper.parseRoleAnswer('').ok, false);
});

test('the best card answer is read strictly and never guessed', () => {
  const ok = Helper.parseBestAnswer('{"best":2,"reason":"card 2 has the full code"}', 3);
  assert.equal(ok.ok, true);
  assert.equal(ok.index, 1, 'returns a 0-based index');
  assert.match(ok.reason, /full code/);
  // A number that does not exist is refused.
  assert.equal(Helper.parseBestAnswer('{"best":4}', 3).ok, false);
  assert.equal(Helper.parseBestAnswer('{"best":0}', 3).ok, false);
  assert.equal(Helper.parseBestAnswer('the second one', 3).ok, false);
});

test('helper prompts carry the project goal and stop at the right size', () => {
  const best = Helper.buildBestPrompt({
    goal: 'Build a to-do app.',
    title: 'arena.ai/c',
    question: 'Write the delete function.',
    cards: [{ text: 'short answer' }, { text: 'a much longer answer' }]
  });
  assert.match(best, /Build a to-do app\./);
  assert.match(best, /Card 1:/);
  assert.match(best, /Card 2:/);
  assert.match(best, /"best"/);
  const roles = Helper.buildRolePrompt({
    leftLabel: 'arena.ai/c',
    rightLabel: 'arena.ai/agent',
    leftUser: 'Plan the work step by step.',
    leftReply: 'Here is the plan...',
    rightUser: 'Do step 1.',
    rightReply: 'Done step 1.'
  });
  assert.match(roles, /A = "arena\.ai\/c"/);
  assert.match(roles, /B = "arena\.ai\/agent"/);
  assert.match(roles, /brain/);
  assert.match(roles, /"brain"/);
});

// ---------- safety: keys and failures ----------
test('the API key never appears in the question that is sent', async () => {
  const api = fakeApi({ text: '{"done":false,"reason":"x"}' });
  await Helper.shouldStop(
    { goal: 'x', round: 1, messages: [] },
    { api, settings: settingsWith({ helperStop: true }), budget: Helper.createBudget(30) }
  );
  const sent = JSON.stringify(api.calls[0].messages);
  assert.ok(!sent.includes('AIzaTEST'), 'the Gemini key is not in the message');
  assert.ok(!sent.includes('xai-TEST'), 'the Grok key is not in the message');
  // The key is handed to the API client separately, which puts it in a header.
  assert.equal(api.calls[0].settings.geminiKey, 'AIzaTEST');
});

test('a failed helper call returns a plain line instead of throwing', async () => {
  const api = fakeApi([{ throw: 'Both API providers failed. Gemini could not be reached.' }]);
  const result = await Helper.shouldStop(
    { goal: 'x', round: 1, messages: [] },
    { api, settings: settingsWith({ helperStop: true }), budget: Helper.createBudget(30) }
  );
  assert.equal(result.checked, false);
  assert.match(result.why, /Both API providers failed/);
  const line = Helper.helperLogLine('stop', { ok: false, error: result.why });
  assert.match(line, /Smart Helper \(auto stop when done\)/);
  assert.match(line, /normal loop carries on/);
});

test('with no key at all the helper skips quietly, so tab mode still works', async () => {
  const api = fakeApi({ text: '{"done":true,"reason":"x"}' });
  const settings = settingsWith({ helperStop: true, geminiKey: '', grokKey: '' });
  const result = await Helper.shouldStop(
    { goal: 'x', round: 1, messages: [] },
    { api, settings, budget: Helper.createBudget(30) }
  );
  assert.equal(result.checked, false);
  assert.equal(result.skipped, true);
  assert.match(result.why, /No API key/);
  assert.equal(api.calls.length, 0);
});

test('an empty answer is a failure, not a "done"', async () => {
  const api = fakeApi({ text: '   ' });
  const result = await Helper.shouldStop(
    { goal: 'x', round: 1, messages: [] },
    { api, settings: settingsWith({ helperStop: true }), budget: Helper.createBudget(30) }
  );
  assert.equal(result.checked, false);
  assert.match(result.why, /empty answer/);
});

// ---------- part 1: auto detect brain and worker ----------
test('detectRoles turns the API answer into the new roles', async () => {
  const api = fakeApi({ text: '{"brain":"B","confidence":"high","reason":"B writes the plan"}', provider: 'gemini' });
  const result = await Helper.detectRoles({
    leftLabel: 'arena.ai/c',
    rightLabel: 'arena.ai/agent',
    leftReply: 'Here is the code.',
    leftUser: 'Do step 1.',
    rightReply: 'Here is the plan.',
    rightUser: 'Plan the work.'
  }, { api, settings: settingsWith({ helperRoles: true }), budget: Helper.createBudget(30) });
  assert.equal(result.ok, true);
  assert.equal(result.brain, 'B');
  assert.equal(result.worker, 'A', 'the brain becomes Tab A and the other one Tab B');
  assert.equal(result.provider, 'gemini');
  const question = api.calls[0].messages[0].content;
  assert.match(question, /Here is the plan\./, 'the reply of each window is sent');
  assert.match(question, /Plan the work\./, 'the last user message is sent too');
  assert.match(question, /"brain"/);
});

test('an unclear role answer changes nothing and says so', async () => {
  const api = fakeApi({ text: 'They look similar to me.' });
  const result = await Helper.detectRoles({}, {
    api, settings: settingsWith({ helperRoles: true }), budget: Helper.createBudget(30)
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not in the shape/);
  assert.equal(result.brain, undefined, 'never guesses a brain');
});

test('detectRoles is off unless the part and the master switch are on', async () => {
  const api = fakeApi({ text: '{"brain":"A"}' });
  const offPart = await Helper.detectRoles({}, {
    api, settings: settingsWith({ helperRoles: false }), budget: Helper.createBudget(30)
  });
  assert.equal(offPart.ok, false);
  assert.equal(offPart.skipped, true);
  const offMaster = await Helper.detectRoles({}, {
    api,
    settings: settingsWith({ helperRoles: true, helperOn: false }),
    budget: Helper.createBudget(30)
  });
  assert.equal(offMaster.ok, false);
  assert.equal(api.calls.length, 0);
});

test('the role sentence names both windows in plain words', () => {
  const sides = { A: 'Left window (arena.ai/c)', B: 'Right window (arena.ai/agent)' };
  const sentence = Helper.roleSentence(
    { ok: true, brain: 'B', worker: 'A', reason: 'B writes the plan.' }, sides);
  assert.match(sentence, /^Right window \(arena\.ai\/agent\) looks like the brain/);
  assert.match(sentence, /Left window \(arena\.ai\/c\) becomes the worker/);
  assert.match(sentence, /B writes the plan\./);
  assert.equal(Helper.roleSentence({ ok: false }, sides), '');
});

// ---------- part 2: pick the best answer card ----------
test('one card is never sent to the API', async () => {
  const api = fakeApi({ text: '{"best":1}' });
  const result = await Helper.chooseBestCard({ cards: [{ text: 'only answer' }], goal: 'x' }, {
    api, settings: settingsWith({ helperBest: true }), budget: Helper.createBudget(30)
  });
  assert.equal(result.ok, true);
  assert.equal(result.index, 0);
  assert.equal(result.skippedApi, true);
  assert.equal(api.calls.length, 0, 'no API call for a single answer');
  assert.match(Helper.bestCardLine(result, 1), /only one answer/);
});

test('several cards: the API decides, and the line names the card and why', async () => {
  const api = fakeApi({ text: '{"best":3,"reason":"card 3 has the full code and handles errors"}', provider: 'gemini' });
  const result = await Helper.chooseBestCard({
    cards: [{ text: 'weak' }, { text: 'ok' }, { text: 'complete with errors handled' }],
    goal: 'Build a to-do app.'
  }, { api, settings: settingsWith({ helperBest: true }), budget: Helper.createBudget(30) });
  assert.equal(result.ok, true);
  assert.equal(result.index, 2, 'a 0-based index');
  assert.equal(result.provider, 'gemini');
  const line = Helper.bestCardLine(result, 3);
  assert.match(line, /^Smart Helper \(Gemini\) chose card 3 of 3: /);
  assert.match(line, /full code and handles errors/);
  // The question carried the goal and every card.
  const question = api.calls[0].messages[0].content;
  assert.match(question, /Build a to-do app\./);
  assert.match(question, /Card 1:/);
  assert.match(question, /Card 3:/);
});

test('an impossible choice is refused and nothing is picked', async () => {
  const api = fakeApi({ text: '{"best":9,"reason":"the best one"}' });
  const result = await Helper.chooseBestCard({ cards: [{ text: 'a' }, { text: 'b' }] }, {
    api, settings: settingsWith({ helperBest: true }), budget: Helper.createBudget(30)
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not exist/);
});

test('the best-card question stays small with very long cards', async () => {
  const api = fakeApi('{"best":1,"reason":"first"}');
  const big = 'x'.repeat(20000);
  await Helper.chooseBestCard({ cards: [{ text: big }, { text: big }], goal: 'g' }, {
    api, settings: settingsWith({ helperBest: true }), budget: Helper.createBudget(30)
  });
  const question = api.calls[0].messages[0].content;
  assert.ok(question.length < 12000, 'each card is cut down: ' + question.length);
});
