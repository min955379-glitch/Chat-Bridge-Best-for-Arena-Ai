// background.js — the service worker that runs the loop,
// the "brain" that makes two chats talk to each other.
// It is a Manifest V3 service worker, so it can be stopped by Chrome when it
// looks idle; the 1-second polling and a small heartbeat keep it alive.
// Plain JavaScript. No frameworks.

importScripts('common.js', 'extract.js', 'api-client.js', 'helper.js');

const Common = self.ChatBridgeCommon;
const Extract = self.ChatBridgeExtract;
const ChatApi = self.ChatBridgeApi;
const Helper = self.ChatBridgeHelper;

// How often the reply is read. The brief asks for 1 second; the tests shrink
// it with the __chatBridgePollMs hook so they finish quickly.
const POLL_MS = (typeof self !== 'undefined' && self.__chatBridgePollMs) || 1000;
// Chrome stops an idle service worker after 30 seconds. Every extension API
// call resets that timer, so this heartbeat (plus the 1-second tab polling)
// keeps the worker alive for the whole run.
const HEARTBEAT_MS = 10000;
const START_TEXT_MAX = 20000;   // do not forward more than this many characters

// The run that is going on right now, or null.
let activeRun = null;
// Storage writes are chained so two writes never overwrite each other.
let writeChain = Promise.resolve();

// ---------- storage helpers ----------
function queueWrite(task) {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return Common.normalizeSettings(stored.settings);
}

async function getRoles() {
  const stored = await chrome.storage.local.get('roles');
  const roles = stored.roles || {};
  return { A: roles.A || null, B: roles.B || null };
}

async function setStatus(text, tone, extra) {
  const status = Object.assign({
    text: text,
    tone: tone || 'idle',
    running: Boolean(activeRun),
    updatedAt: Date.now()
  }, extra || {});
  await queueWrite(() => chrome.storage.local.set({ status: status }));
}

async function addLog(text) {
  // Belt and braces: an API error message could echo a key back, so every
  // line is cleaned before it is written or shown.
  const settings = typeof activeRun === 'object' && activeRun
    ? activeRun.settings
    : await getSettings();
  const line = { t: Date.now(), text: Common.hideSecret(String(text), settings) };
  await queueWrite(async () => {
    const stored = await chrome.storage.local.get('log');
    const list = Array.isArray(stored.log) ? stored.log : [];
    list.push(line);
    await chrome.storage.local.set({ log: list.slice(-20) });
  });
}

async function setRunFlag(running, note) {
  await queueWrite(() => chrome.storage.local.set({
    run: { running: Boolean(running), note: note || '', changedAt: Date.now() }
  }));
}

// ---------- talking to a tab ----------
async function injectContentScripts(tabId) {
  // The page was opened before the extension was installed, so the content
  // script is missing. Put it in now. The files are listed in order.
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['selectors.js', 'extract.js', 'common.js', 'content.js']
  });
}

function plainError(err, fallback) {
  const message = err && err.message ? String(err.message) : '';
  if (/Cannot access|chrome:\/\/|edge:\/\/|about:|chrome-extension:/i.test(message)) {
    return 'Chrome does not allow the extension on this page (' + message + '). Open a normal website tab.';
  }
  if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(message)) {
    return 'The page is not ready yet. Open the tab and reload it (F5), then try again.';
  }
  return message || fallback || 'Something went wrong.';
}

// Send one message to a tab. If the content script is missing, add it and retry.
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    try {
      await injectContentScripts(tabId);
    } catch (injectError) {
      throw new Error(plainError(injectError, 'I could not reach the page. Reload the tab and try again.'));
    }
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (secondError) {
      throw new Error(plainError(secondError, 'The page is not answering. Reload the tab and try again.'));
    }
  }
}

// Read the last reply in a tab: { ok, count, text, code }
// An empty chat is a normal reading (count 0), not an error: a brand-new chat
// must still be usable as Tab A or Tab B. Only a missing pick fails here.
async function readTab(tabId) {
  const reply = await sendToTab(tabId, { type: 'readReply' });
  if (!reply) throw new Error('The page did not answer. Reload the tab and try again.');
  if (reply.error) throw new Error(reply.error);
  // Trust nothing from the page: keep only text and a number.
  const count = Number(reply.count) || 0;
  const text = typeof reply.text === 'string' ? reply.text : String(reply.text == null ? '' : reply.text);
  return {
    ok: true,
    count: count,
    text: count === 0 ? '' : text,
    code: count === 0 ? '' : (typeof reply.code === 'string' ? reply.code : '')
  };
}

// Two pieces of text are "the same" when only spacing and line breaks differ.
function normaliseForCompare(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

// Did the tab's newest reply change into something we did not just send?
// count 0 means "the page shows no reply at all", which is not our message
// and is not the AI answering either.
function isForeignChange(current, sentText) {
  if (current.count === 0) return false;
  const now = normaliseForCompare(current.text);
  if (!now) return false;
  // Our own pasted message (or a piece of it) appeared as the newest reply:
  // wait for the AI's answer instead of forwarding our own text back.
  const sent = normaliseForCompare(sentText);
  if (sent) {
    if (now === sent) return false;
    if (now.startsWith(sent)) return false;
  }
  return true;
}

// Put a message into a tab and press send.
async function deliverToTab(tabId, text) {
  const sent = await sendToTab(tabId, { type: 'deliver', text: text });
  if (!sent) throw new Error('The page did not answer. Reload the tab and try again.');
  if (sent.error) throw new Error(sent.error);
}

// ---------- run control ----------
class StopSignal extends Error {
  constructor() { super('Stopped by you.'); this.name = 'StopSignal'; }
}

function checkStop() {
  if (!activeRun || activeRun.stopRequested) throw new StopSignal();
}

// Wait that reacts to Stop quickly.
async function pause(ms) {
  const step = 100;
  let left = ms;
  while (left > 0) {
    checkStop();
    const slice = Math.min(step, left);
    await new Promise((resolve) => setTimeout(resolve, slice));
    left -= slice;
  }
}

function roleTitle(run, role) {
  const tabId = run.roles[role];
  const title = run.titles[tabId] || ('Tab ' + role);
  return role + ' (' + title + ')';
}

// Choose the part of a reply the user asked for.
function applyMode(reply, mode, markers) {
  const full = Extract.cleanText(reply.text || '');
  if (!full) return { error: 'The last reply is empty right now.' };
  if (mode === 'code') {
    if (reply.code) {
      const codeText = Extract.cleanText(reply.code);
      return codeText ? { text: codeText } : { error: 'The last code block in the reply is empty.' };
    }
    return Extract.applyModeToText(full, 'code', markers);
  }
  if (mode === 'markers') return Extract.betweenMarkers(full, markers);
  return { text: full };
}

// Read the newest reply with the chosen copy mode (used for the first message).
async function readPickedText(run, role) {
  const tabId = run.roles[role];
  const mode = role === 'A' ? run.settings.copyModeA : run.settings.copyModeB;
  const reply = await readTab(tabId);
  const picked = applyMode(reply, mode, { start: run.settings.markerStart, end: run.settings.markerEnd });
  if (picked.error) {
    throw new Error('I could not read the first message from ' + roleTitle(run, role) + ': ' + picked.error);
  }
  return picked.text;
}

// Wait until the tab produces a NEW reply and stops changing.
async function waitForNewReply(run, role, baseline, sentText) {
  const tabId = run.roles[role];
  const silence = run.settings.silence;
  const deadline = Date.now() + run.settings.timeout * 1000;
  let seen = false;
  let lastText = '';
  let lastChange = 0;
  let lastWritten = '';
  // The message we pasted, so we do not mistake it for the AI's answer.
  const sent = normaliseForCompare(sentText);

  for (;;) {
    checkStop();
    const reply = await readTab(tabId);
    const now = Date.now();

    // A change compared with what was on the page before we pasted, that is
    // also not our own message coming back.
    const changed = reply.count !== baseline.count || reply.text !== baseline.text;

    if (!seen && changed && isForeignChange(reply, sent)) {
      seen = true;
      lastText = reply.text;
      lastChange = now;
      await addLog(roleTitle(run, role) + ' started answering.');
    } else if (seen) {
      // While waiting, ignore a return to "no reply" and an echo of our own
      // message: only real text from the AI restarts the silence counter.
      if (isForeignChange(reply, sent) && reply.text !== lastText) {
        lastText = reply.text;
        lastChange = now;
      }
    }

    // Whole seconds with no change in the reply.
    const silentFor = seen ? Math.floor((now - lastChange) / 1000) : 0;
    const unfinished = seen && Extract.looksUnfinished(lastText);
    const needed = unfinished ? silence * 2 : silence;

    const statusText = seen
      ? 'waiting for ' + role + ' to finish (' + silentFor + 's of ' + needed + 's silence)'
      : 'waiting for ' + role + ' to start answering';
    if (statusText !== lastWritten) {
      lastWritten = statusText;
      await setStatus(run.statusPrefix + statusText, 'running', { waitSince: seen ? lastChange : now });
    }

    if (seen && silentFor >= needed && String(lastText || '').trim()) {
      // Return the reading that ended the wait, so a reply that finished at
      // the same moment is not missed.
      return reply.count > 0 ? reply : Object.assign({}, reply, { count: 1, text: lastText });
    }

    if (now > deadline) {
      const hint = seen
        ? 'It started answering but never went quiet. You can raise "seconds of silence" in Settings.'
        : 'It did not start answering. Some sites do not accept pasting into a background tab: ' +
          'put the two chats in two separate Chrome windows.';
      throw new Error('Timed out waiting for Tab ' + role + '. ' + hint);
    }
    await pause(POLL_MS);
  }
}

// One direction of the loop: take "text" and send it from one tab to the other.
async function forward(run, fromRole, toRole, text) {
  checkStop();
  const fromTab = run.roles[fromRole];
  const toTab = run.roles[toRole];
  const settings = run.settings;

  await setStatus(run.statusPrefix + 'sending ' + fromRole + ' → ' + toRole, 'running');
  const baseline = await readTab(toTab);
  const message = Common.wrapMessage(settings.prefix, text, settings.suffix);
  if (!message) throw new Error('There is nothing to send: the last reply was empty.');
  run.lastSent = message.length > 600 ? message.slice(0, 600) + '…' : message;
  if (message.length > START_TEXT_MAX) {
    throw new Error('The reply is very long (' + message.length + ' characters). ' +
      'Many chat boxes refuse a message that big. Use "Between markers" or "Last code block" ' +
      'to forward a shorter part.');
  }
  await addLog('Sending ' + message.length + ' characters from ' + fromRole + ' to ' + toRole + '.');
  await deliverToTab(toTab, message);

  // The waiter gets the sent text, so a page that shows our message back as
  // the newest "reply" is not mistaken for the AI answering.
  let reply = await waitForNewReply(run, toRole, baseline, message);
  // Part 2: a tab with several answer cards hands over the best one.
  reply = await chooseBestReply(run, toRole, reply);
  const mode = toRole === 'A' ? settings.copyModeA : settings.copyModeB;
  const picked = applyMode(reply, mode, { start: settings.markerStart, end: settings.markerEnd });
  if (picked.error) {
    throw new Error('I read a new answer from ' + roleTitle(run, toRole) + ' but ' + picked.error);
  }
  await addLog(toRole + ' answered with ' + picked.text.length + ' characters.');
  return picked.text;
}

// Check the stop word and the "identical reply" option. Returns a stop reason.
function checkStopOptions(run, role, text, previousText) {
  const word = String(run.settings.stopWord || '').trim();
  if (word && text.toLowerCase().includes(word.toLowerCase())) {
    return 'Stopped because the reply from ' + role + ' contains "' + word + '".';
  }
  if (run.settings.stopIfSame && previousText && text.trim() === previousText.trim()) {
    return 'Stopped because the new reply from ' + role + ' is identical to the previous one. ' +
      'The two AIs are probably stuck in a loop.';
  }
  return '';
}

// ---------- the Smart Helper ----------

// Keep the last few messages in the run, for the helper questions. Only the
// newest handful is ever sent, never the whole chat.
const HISTORY_MAX = 8;
function remember(run, role, text) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return;
  if (!run.history) run.history = [];
  run.history.push({ who: 'Tab ' + role + ' (' + roleTitle(run, role) + ')', text: clean });
  while (run.history.length > HISTORY_MAX) run.history.shift();
}

// Make one Smart Helper call for this run. Never throws: a failure or a
// timeout comes back as { ok:false } and the normal loop carries on.
async function helperAsk(run, job, question, systemPrompt) {
  if (!Helper || !run.helperBudget) {
    return { ok: false, skipped: true, error: 'The Smart Helper is not loaded.' };
  }
  const result = await Helper.ask(question, systemPrompt, {
    api: ChatApi,
    settings: run.settings,
    budget: run.helperBudget,
    cooldowns: run.cooldowns,
    fetch: run.helperFetch
  });
  if (result.ok) {
    await addLog('Smart Helper (' + Helper.jobName(job) + ') answered with ' + Helper.providerName(result.provider) +
      ' in ' + Math.round((result.milliseconds || 0) / 1000) + 's (' + run.helperBudget.left() + ' calls left).');
    for (const note of result.notes || []) await addLog(note);
  } else {
    await addLog(Helper.helperLogLine(job, result));
  }
  return result;
}

// Part 2: when a tab shows several answer cards for the newest turn, read all
// of them and keep the one the API says is best for the project goal. With a
// single card the API is never called. Any problem leaves the reply as it is.
async function chooseBestReply(run, role, reply) {
  const settings = run.settings;
  if (!Helper || !Helper.on(settings, 'best')) return reply;
  const tabId = run.roles[role];
  let group;
  try {
    group = await sendToTab(tabId, { type: 'readReplyGroup' });
  } catch (err) {
    await addLog('Smart Helper (pick the best answer) could not read the answer cards: ' +
      plainError(err, 'the page did not answer') + ' The newest answer is used.');
    return reply;
  }
  if (!group || group.error || !Array.isArray(group.cards) || group.cards.length <= 1) {
    // One card (or none) means there is nothing to choose, so no API call.
    return reply;
  }

  const mode = role === 'A' ? settings.copyModeA : settings.copyModeB;
  const markers = { start: settings.markerStart, end: settings.markerEnd };
  // Ask about the text the copy mode would forward, so the choice matches
  // what would really be sent.
  const cards = group.cards.map(function (card) {
    const picked = applyMode(card, mode, markers);
    return { text: picked.error ? card.text : picked.text, code: card.code };
  });
  const info = await tabInfo(tabId, role);
  const result = await Helper.chooseBestCard({
    cards: cards,
    goal: settings.goal,
    title: info.ok ? info.label : roleTitle(run, role),
    question: run.lastSent || ''
  }, {
    api: ChatApi,
    settings: settings,
    budget: run.helperBudget,
    cooldowns: run.cooldowns,
    fetch: run.helperFetch,
    ask: (question, systemPrompt) => helperAsk(run, 'best', question, systemPrompt)
  });

  if (!result.ok) {
    await addLog(Helper.helperLogLine('best', result) + ' The newest answer is used.');
    return reply;
  }
  if (result.skippedApi) {
    await addLog(Helper.bestCardLine(result, cards.length));
    return reply;
  }
  await addLog(Helper.bestCardLine(result, cards.length));
  const chosen = group.cards[result.index];
  if (!chosen) return reply;
  // Return the chosen card in the same shape as a normal reading.
  return Object.assign({}, reply, { count: group.cards.length, text: chosen.text, code: chosen.code || '' });
}

// Part 3: after a round, ask whether the project is finished. Returns the
// stop sentence when it is, otherwise '' (and logs the reason either way).
async function autoStopCheck(run, round) {
  const settings = run.settings;
  if (!Helper || !Helper.stopCheckDue(settings, round)) return '';
  checkStop();
  const result = await Helper.shouldStop({
    goal: settings.goal,
    round: round,
    messages: run.history || []
  }, {
    api: ChatApi,
    settings: settings,
    budget: run.helperBudget,
    cooldowns: run.cooldowns,
    fetch: run.helperFetch,
    // Log every call through helperAsk, so the provider is always named.
    ask: (question, systemPrompt) => helperAsk(run, 'stop', question, systemPrompt)
  });
  if (!result.checked) {
    // Every skipped or failed check says so once, in plain words, so the log
    // never hides why the Smart Helper did nothing.
    if (result.provider) {
      await addLog('Smart Helper (' + Helper.providerName(result.provider) + '): ' + result.why);
    } else if (result.skipped) {
      await addLog('Smart Helper (auto stop when done) was skipped: ' + result.why);
    } else {
      await addLog('Smart Helper (auto stop when done) could not answer: ' + result.why +
        ' The normal loop carries on.');
    }
    return '';
  }
  if (result.done) return result.stopText || 'Stopped by the Smart Helper: the project is finished.';
  if (result.log) await addLog(result.log);
  return '';
}

// ---------- tab to tab mode ----------
async function runTabMode(run) {
  const settings = run.settings;
  const rounds = Common.effectiveRounds(settings);
  await addLog('Tab mode started: ' + rounds + ' round' + (rounds === 1 ? '' : 's') + '.');

  await setStatus('Reading the first message from Tab A', 'running');
  let outgoing = await readPickedText(run, 'A');
  const previous = { A: outgoing, B: '' };
  remember(run, 'A', outgoing);

  for (let round = 1; round <= rounds; round++) {
    run.statusPrefix = 'Round ' + round + '/' + rounds + ': ';
    for (const [from, to] of [['A', 'B'], ['B', 'A']]) {
      checkStop();
      const newText = await forward(run, from, to, outgoing);
      remember(run, to, newText);
      const stopReason = checkStopOptions(run, to, newText, previous[to]);
      previous[to] = newText;
      outgoing = newText;
      if (stopReason) {
        await addLog(stopReason);
        await setStatus(stopReason, 'done');
        return { finished: false, reason: stopReason };
      }
      if (to === 'A') {
        await addLog('Round ' + round + ' of ' + rounds + ' finished.');
        // Part 3: the round is complete, so this is the moment to ask whether
        // the project is finished.
        const helperStop = await autoStopCheck(run, round);
        if (helperStop) {
          await addLog(helperStop);
          await setStatus(helperStop, 'done');
          return { finished: false, reason: helperStop, helperStopped: true };
        }
      }
    }
  }
  const done = 'Finished all ' + rounds + ' round' + (rounds === 1 ? '' : 's') + '.';
  await setStatus(done, 'done');
  await addLog(done);
  return { finished: true, reason: done };
}

// Keep only the newest few messages, but always start on a user message:
// Gemini requires the conversation to begin with the user's turn.
function trimMemory(memory, limit) {
  const max = Math.max(1, Number(limit) || 1);
  while (memory.length > max) {
    memory.shift();
    if (memory.length && memory[0].role !== 'user') memory.shift();
  }
}

// ---------- API mode: Tab A <-> API ----------
async function runApiMode(run) {
  const settings = run.settings;
  const rounds = Common.effectiveRounds(settings);
  const primary = Common.providerLabel(settings.provider);
  await addLog('API mode started with ' + primary + ' as the main provider, ' + rounds +
    ' round' + (rounds === 1 ? '' : 's') + '.');

  await setStatus('Reading the first message from Tab A', 'running');
  let outgoing = await readPickedText(run, 'A');
  remember(run, 'A', outgoing);
  let previous = outgoing;
  const memory = []; // { role: 'user' | 'assistant', content }
  // One cooldown table for the whole run, so a provider that answered 429 in
  // an earlier round is still skipped in the later rounds. The Smart Helper
  // shares it, so both talk about the same resting providers.
  const cooldowns = run.cooldowns;

  for (let round = 1; round <= rounds; round++) {
    checkStop();
    run.statusPrefix = 'Round ' + round + '/' + rounds + ': ';

    // 1. Ask the API.
    await setStatus(run.statusPrefix + 'asking ' + primary, 'running');
    memory.push({ role: 'user', content: Common.wrapMessage(settings.prefix, outgoing, settings.suffix) });
    trimMemory(memory, settings.memory);
    const startedAt = Date.now();
    const answer = await ChatApi.requestWithFallback(memory, {
      provider: settings.provider,
      geminiKey: settings.geminiKey,
      geminiModel: settings.geminiModel,
      grokKey: settings.grokKey,
      grokModel: settings.grokModel,
      systemPrompt: settings.systemPrompt
    }, { cooldowns: cooldowns });
    for (const note of answer.notes || []) await addLog(note);
    const providerName = Common.providerLabel(answer.provider);
    await addLog(providerName + ' answered in ' + Math.round((Date.now() - startedAt) / 1000) +
      's with ' + answer.text.length + ' characters.');
    memory.push({ role: 'assistant', content: answer.text });

    // 2. Paste the answer into Tab A and wait for Tab A's own answer.
    await setStatus(run.statusPrefix + providerName + ' answered. Pasting it into Tab A', 'running');
    const baseline = await readTab(run.roles.A);
    const pastedIntoA = Common.wrapMessage(settings.prefix, answer.text, settings.suffix);
    await deliverToTab(run.roles.A, pastedIntoA);
    let reply = await waitForNewReply(run, 'A', baseline, pastedIntoA);
    reply = await chooseBestReply(run, 'A', reply);
    const picked = applyMode(reply, settings.copyModeA, {
      start: settings.markerStart, end: settings.markerEnd
    });
    if (picked.error) {
      throw new Error('I read a new answer from Tab A but ' + picked.error);
    }
    remember(run, 'A', picked.text);
    const stopReason = checkStopOptions(run, 'A', picked.text, previous);
    previous = picked.text;
    outgoing = picked.text;
    if (stopReason) {
      await addLog(stopReason);
      await setStatus(stopReason, 'done');
      return { finished: false, reason: stopReason };
    }
    await addLog('Round ' + round + ' of ' + rounds + ' finished (' + providerName + ').');
    const helperStop = await autoStopCheck(run, round);
    if (helperStop) {
      await addLog(helperStop);
      await setStatus(helperStop, 'done');
      return { finished: false, reason: helperStop, helperStopped: true };
    }
  }
  const done = 'Finished all ' + rounds + ' round' + (rounds === 1 ? '' : 's') + '.';
  await setStatus(done, 'done');
  await addLog(done);
  return { finished: true, reason: done };
}

// ---------- part 1: auto detect brain and worker ----------
// Read the last user message and the last AI reply of a tab. Missing pieces
// come back as empty text, never as an error.
async function readTabSample(tabId) {
  try {
    const reply = await readTab(tabId);
    let lastUser = '';
    try {
      const user = await sendToTab(tabId, { type: 'readLastUser' });
      if (user && !user.error && typeof user.text === 'string') lastUser = user.text;
    } catch (err) { /* the user message is a bonus, not required */ }
    return { ok: true, reply: reply.text || '', lastUser: lastUser };
  } catch (err) {
    return { ok: false, error: plainError(err, 'That tab could not be read.') };
  }
}

// Ask the API which window is the brain. Never changes anything on failure.
// Returns { ok, brain, worker, message, provider } with plain-English text.
async function detectRoles() {
  const settings = await getSettings();
  const roles = await getRoles();
  if (!roles.A || !roles.B) {
    return {
      error: 'Choose Tab A and Tab B first. Open each chat tab and press "Make this Tab A" ' +
        'or "Make this Tab B".'
    };
  }
  if (!Helper || !Helper.on(settings, 'roles')) {
    return { error: 'Switch on the Smart Helper and tick "Auto detect brain and worker" first.' };
  }
  const infoA = await tabInfo(roles.A, 'A');
  const infoB = await tabInfo(roles.B, 'B');
  if (!infoA.ok) return { error: infoA.error };
  if (!infoB.ok) return { error: infoB.error };

  const sampleA = await readTabSample(roles.A);
  const sampleB = await readTabSample(roles.B);
  if (!sampleA.ok || !sampleB.ok) {
    return { error: 'I could not read both tabs. ' + (sampleA.error || sampleB.error) };
  }

  const sides = {
    A: 'Left window (' + infoA.label + ')',
    B: 'Right window (' + infoB.label + ')'
  };
  const budget = Helper.createBudget(Helper.maxCalls(settings));
  const result = await Helper.detectRoles({
    leftLabel: infoA.label,
    rightLabel: infoB.label,
    leftReply: sampleA.reply,
    leftUser: sampleA.lastUser,
    rightReply: sampleB.reply,
    rightUser: sampleB.lastUser
  }, {
    api: ChatApi,
    settings: settings,
    budget: budget,
    cooldowns: { gemini: 0, grok: 0 },
    ask: async (question, systemPrompt) => {
      const answer = await Helper.ask(question, systemPrompt, {
        api: ChatApi,
        settings: settings,
        budget: budget,
        cooldowns: { gemini: 0, grok: 0 }
      });
      if (answer.ok) {
        await addLog('Smart Helper (auto detect brain and worker) answered with ' +
          Helper.providerName(answer.provider) + '.');
      } else {
        await addLog(Helper.helperLogLine('roles', answer));
      }
      return answer;
    }
  });

  if (!result.ok) {
    const why = result.skipped
      ? result.error
      : 'The Smart Helper could not tell which window is the brain: ' + result.error;
    return { error: why + ' Nothing was changed.' };
  }

  // Brain becomes Tab A, worker becomes Tab B.
  const brainTab = result.brain === 'A' ? roles.A : roles.B;
  const workerTab = result.brain === 'A' ? roles.B : roles.A;
  const titles = (await chrome.storage.local.get('roleTitles')).roleTitles || {};
  if (infoA.ok) titles[roles.A] = infoA.tab.title || infoA.label;
  if (infoB.ok) titles[roles.B] = infoB.tab.title || infoB.label;
  await chrome.storage.local.set({
    roles: { A: brainTab, B: workerTab },
    roleTitles: titles,
    helperDetect: {
      t: Date.now(),
      brain: result.brain,
      message: Helper.roleSentence(result, sides),
      provider: result.provider
    }
  });
  const sentence = Helper.roleSentence(result, sides);
  await addLog('Smart Helper set the roles: ' + sentence);
  return { ok: true, brain: result.brain, message: sentence, provider: result.provider };
}

// ---------- checking everything before a run ----------
async function tabInfo(tabId, role) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { ok: true, tab: tab, key: Common.siteKeyFor(tab.url || ''), label: Common.siteLabel(tab.url || '') };
  } catch (err) {
    // Say which tab and which button, in plain words.
    const which = role === 'A' || role === 'B' ? 'Tab ' + role : 'That tab';
    return {
      ok: false,
      error: which + ' is closed. Open the chat you want and press "Make this ' + which + '" again.'
    };
  }
}

async function validateRun(settings) {
  const roles = await getRoles();
  const problems = [];

  if (!roles.A) problems.push('Tab A is not chosen yet. Open the first chat tab and press "Make this Tab A".');
  if (settings.mode === 'tab' && !roles.B) {
    problems.push('Tab B is not chosen yet. Open the second chat tab and press "Make this Tab B".');
  }
  if (roles.A && roles.B && roles.A === roles.B) {
    problems.push('Tab A and Tab B are the same tab. Use two different tabs.');
  }
  if (problems.length) return { problems: problems };

  // Check every tab that this mode needs, and report a closed one right away.
  const need = settings.mode === 'tab' ? ['A', 'B'] : ['A'];
  for (const role of need) {
    const info = await tabInfo(roles[role], role);
    if (!info.ok) {
      problems.push(info.error);
      continue;
    }
    const stored = await chrome.storage.local.get(Common.pickStorageKey(info.key));
    const picks = stored[Common.pickStorageKey(info.key)] || {};
    const missing = [];
    if (!picks.input) missing.push('chat box');
    if (!picks.reply) missing.push('AI reply');
    if (missing.length) {
      problems.push('Tab ' + role + ' (' + info.label + ') needs the ' + missing.join(' and ') +
        ' picked. Click this tab, then press the pick buttons in the popup.');
    }
  }

  if (settings.mode === 'api') {
    // Only the main provider's key is required. The second key enables the
    // automatic backup, but a run without it still works.
    if (!Common.hasProviderKey(settings, settings.provider)) {
      problems.push('API mode needs an API key for ' + Common.providerLabel(settings.provider) +
        '. Add it in Settings.');
    }
  }
  return { problems: problems };
}

// ---------- starting and stopping ----------
async function startRun() {
  if (activeRun) return { error: 'A run is already going. Press Stop first.' };
  const settings = await getSettings();
  const check = await validateRun(settings);
  if (check.problems.length) {
    // One problem per line, so the popup can show a tidy list.
    const message = check.problems.join('\n');
    await setStatus(message, 'error');
    await addLog(message);
    return { error: message };
  }

  const roles = await getRoles();
  const run = {
    settings: settings,
    roles: roles,
    stopRequested: false,
    statusPrefix: '',
    titles: {},
    heartbeat: null,
    // The newest few messages, for the Smart Helper questions.
    history: [],
    // One cooldown table and one call budget for the whole run.
    cooldowns: { gemini: 0, grok: 0 },
    helperBudget: Helper ? Helper.createBudget(Helper.maxCalls(settings)) : null
  };
  for (const role of ['A', 'B']) {
    if (!roles[role]) continue;
    const info = await tabInfo(roles[role], role);
    if (info.ok) run.titles[roles[role]] = info.tab.title || info.label;
  }
  activeRun = run;
  await setRunFlag(true, '');
  await setStatus('Starting...', 'running');
  await addLog('Run started in ' + (settings.mode === 'api' ? 'API' : 'tab to tab') + ' mode.');
  if (Helper && Helper.anyPartOn(settings)) {
    const parts = [];
    if (Helper.on(settings, 'stop')) parts.push('auto stop when done');
    if (Helper.on(settings, 'roles')) parts.push('auto detect brain and worker');
    if (Helper.on(settings, 'best')) parts.push('pick the best answer');
    await addLog('Smart Helper is on: ' + parts.join(', ') + '. Up to ' +
      run.helperBudget.limit + ' API calls for this run.');
  }

  // A small extension call every 10 seconds keeps the service worker awake,
  // even while a long API request is waiting for an answer.
  run.heartbeat = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, HEARTBEAT_MS);

  try {
    const result = settings.mode === 'api' ? await runApiMode(run) : await runTabMode(run);
    return { ok: true, result: result };
  } catch (err) {
    if (err instanceof StopSignal) {
      await setStatus('Stopped by you.', 'stopped');
      await addLog('Run stopped by you.');
      return { ok: true, stopped: true };
    }
    const message = 'Error: ' + (err && err.message ? err.message : String(err));
    await setStatus(message, 'error');
    await addLog(message);
    return { error: message };
  } finally {
    if (run.heartbeat) clearInterval(run.heartbeat);
    // Clear the run BEFORE writing the final status, so the popup sees
    // "running: false" and enables the Start button again.
    activeRun = null;
    await setRunFlag(false, '');
    const last = await chrome.storage.local.get('status');
    if (last.status) {
      await queueWrite(() => chrome.storage.local.set({
        status: Object.assign({}, last.status, { running: false, updatedAt: Date.now() })
      }));
    }
  }
}

async function stopRun() {
  if (!activeRun) {
    await setStatus('Nothing is running.', 'idle');
    await setRunFlag(false, '');
    return { ok: true };
  }
  activeRun.stopRequested = true;
  await setStatus('Stopping...', 'stopped');
  return { ok: true };
}

// ---------- messages from the popup ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  (async () => {
    if (type === 'start') return startRun();
    if (type === 'stop') return stopRun();
    if (type === 'state') {
      return {
        running: Boolean(activeRun),
        roles: await getRoles()
      };
    }
    if (type === 'detectRoles') return detectRoles();
    if (type === 'check') {
      const settings = await getSettings();
      return await validateRun(settings);
    }
    return { error: 'Unknown request.' };
  })().then(
    (result) => { try { sendResponse(result); } catch (err) { /* popup closed */ } },
    (err) => {
      try {
        sendResponse({ error: plainError(err, 'Something went wrong in the background worker.') });
      } catch (closeErr) { /* popup closed */ }
    }
  );
  return true; // async answer follows
});

// ---------- startup checks ----------
(async function startup() {
  try {
    const stored = await chrome.storage.local.get('run');
    const run = stored.run || {};
    if (run.running && !activeRun) {
      // Chrome stopped the worker in the middle of a run, so the loop is gone.
      await setRunFlag(false, 'interrupted');
      await setStatus('Run was interrupted because Chrome restarted the extension in the background. ' +
        'Press Start again.', 'error');
      await addLog('Run interrupted by a background restart.');
    }
  } catch (err) {
    // Never crash silently: leave a note in storage for the popup.
    await chrome.storage.local.set({
      status: { text: 'The extension had a small problem at startup. Reload it in chrome://extensions.',
        tone: 'error', running: false, updatedAt: Date.now() }
    }).catch(() => {});
  }
})();

chrome.runtime.onInstalled.addListener(() => {
  // First install: make sure a friendly status line exists.
  chrome.storage.local.get('status').then((stored) => {
    if (!stored.status) {
      return chrome.storage.local.set({
        status: { text: 'Welcome! Pick the three spots on your chat tab, then press Start.',
          tone: 'idle', running: false, updatedAt: Date.now() }
      });
    }
    return undefined;
  }).catch(() => {});
});
