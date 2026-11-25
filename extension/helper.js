// helper.js — the "Smart Helper": three optional jobs that use the same
// Gemini / Grok API client (api-client.js) as API mode, with the same
// automatic fallback between the two providers.
//
//   1. Auto detect the brain and the worker
//   2. Pick the best answer when a tab shows several answer cards
//   3. Auto stop when the project goal is finished
//
// Rules this file keeps, every time:
//   * Nothing here runs unless the master switch is on and the part's own
//     checkbox is on.
//   * Only the last few messages are sent, never the whole chat.
//   * Every call is counted against "Max helper calls per run".
//   * A failed or timed-out call never throws into the loop: it returns
//     ok:false with a plain-English line for the log.
//   * API keys only ever go into the request headers, never into the text
//     that is sent, the log, or a status line.
//
// Plain JavaScript, no dependencies. Loadable in Node for the tests.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatBridgeHelper = api;
})(typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  const PARTS = ['roles', 'best', 'stop'];
  const DEFAULT_MAX_CALLS = 30;

  // How much of a chat is sent with each question. Short on purpose: the
  // helper needs the gist, not the whole conversation.
  const TEXT_LIMIT = 1200;      // characters per message
  const CARD_LIMIT = 3000;      // characters per answer card
  const MESSAGES_LIMIT = 6;     // how many recent messages are sent

  // A plain, short instruction for each job. The last line of every one of
  // them says what shape the answer must have, because parsing needs it.
  const PROMPTS = {
    roles: 'You are helping a tool that connects two AI chat windows. ' +
      'One window gives instructions and plans; the other does the work. ' +
      'The window that gives instructions and plans is called the brain. ' +
      'The window that carries out the work is called the worker.',
    best: 'You are helping a tool that connects two AI chat windows. ' +
      'One chat window showed several answer cards for the same question. ' +
      'Choose the one that is most useful for the project goal: the most complete, ' +
      'correct and directly usable answer.',
    stop: 'You are helping a tool that connects two AI chat windows. ' +
      'You are given the project goal and the latest messages between the two chats. ' +
      'Decide whether the project is finished.'
  };

  // ---------- small helpers ----------
  function on(settings, part) {
    // The master switch has the last word: with it off, no part runs.
    if (!settings || !settings.helperOn) return false;
    if (part === 'roles') return Boolean(settings.helperRoles);
    if (part === 'best') return Boolean(settings.helperBest);
    if (part === 'stop') return Boolean(settings.helperStop);
    return false;
  }

  function anyPartOn(settings) {
    return PARTS.some(function (part) { return on(settings, part); });
  }

  function maxCalls(settings) {
    const raw = settings ? settings.helperMaxCalls : undefined;
    // An empty box means "not filled in", not "zero calls".
    if (raw === '' || raw === null || raw === undefined) return DEFAULT_MAX_CALLS;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return DEFAULT_MAX_CALLS;
    return Math.min(500, Math.max(0, n));
  }

  // A short, single-line version of a text, for the log.
  function oneLine(text, max) {
    const limit = max || 120;
    const value = String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim();
    return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
  }

  // Cut a long text to a readable size, and say that it was cut, so the AI
  // does not think the answer simply stopped.
  function clip(text, limit) {
    const value = String(text == null ? '' : text).trim();
    const max = limit || TEXT_LIMIT;
    if (value.length <= max) return value;
    return value.slice(0, max) + '\n…(the rest was cut to keep the message short)';
  }

  // The newest N messages, oldest first, each cut to a readable size.
  function recentMessages(list, limit) {
    const items = Array.isArray(list) ? list.filter(Boolean) : [];
    const max = Math.max(1, limit || MESSAGES_LIMIT);
    return items.slice(-max).map(function (item) {
      return { who: String(item.who || 'a chat'), text: clip(item.text) };
    });
  }

  // Turn a list of messages into the plain block that is sent to the API.
  function transcript(messages) {
    return messages.map(function (m) {
      return m.who + ' wrote:\n' + m.text;
    }).join('\n\n---\n\n');
  }

  // ---------- talking to the API ----------
  // One helper call, never more than the run allows.
  //   deps: { api, settings, budget, fetch, now, sleep, cooldowns }
  // Returns:
  //   { ok:true, text, provider, milliseconds, notes }
  //   { ok:false, error, skipped:true }   nothing was sent
  //   { ok:false, error }                 the API failed
  async function ask(question, systemPrompt, deps) {
    const d = deps || {};
    const settings = d.settings || {};
    const provider = String(settings.provider || 'gemini');
    if (provider !== 'gemini' && provider !== 'grok') {
      return { ok: false, error: 'Unknown provider.' };
    }
    if (!d.api || typeof d.api.requestWithFallback !== 'function') {
      return { ok: false, error: 'The API helper is not loaded.' };
    }
    // No key at all, for either provider: skip quietly. Tab to tab mode with
    // the helper parts on and no keys must still work.
    const hasAnyKey = Boolean(String(settings.geminiKey || '').trim()) ||
      Boolean(String(settings.grokKey || '').trim());
    if (!hasAnyKey) {
      return { ok: false, skipped: true, error: 'No API key is saved, so the Smart Helper is skipped.' };
    }
    if (d.budget && typeof d.budget.take === 'function') {
      const allowed = d.budget.take();
      if (!allowed) {
        return { ok: false, skipped: true, error: 'The Smart Helper used all its calls for this run.' };
      }
    }

    const started = Date.now();
    try {
      const answer = await d.api.requestWithFallback(
        [{ role: 'user', content: question }],
        {
          provider: provider,
          geminiKey: settings.geminiKey,
          geminiModel: settings.geminiModel,
          grokKey: settings.grokKey,
          grokModel: settings.grokModel,
          systemPrompt: systemPrompt || ''
        },
        { fetch: d.fetch, now: d.now, sleep: d.sleep, cooldowns: d.cooldowns }
      );
      const text = String((answer && answer.text) || '').trim();
      if (!text) {
        return { ok: false, error: 'The API sent an empty answer.', provider: answer && answer.provider };
      }
      return {
        ok: true,
        text: text,
        provider: answer.provider,
        milliseconds: Date.now() - started,
        notes: answer.notes || []
      };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  // Pull the first JSON object out of an answer. Models like to add a
  // sentence or wrap it in ```json fences, so be forgiving about that.
  function parseJsonObject(text) {
    const source = String(text == null ? '' : text).trim();
    if (!source) return null;
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : source;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const value = JSON.parse(body.slice(start, end + 1));
      return value && typeof value === 'object' ? value : null;
    } catch (err) {
      return null;
    }
  }

  // ---------- part 1: brain and worker ----------
  // Build the question for "which window is the brain?".
  function buildRolePrompt(input) {
    const sides = [
      { role: 'A', label: String(input.leftLabel || 'Left window'), last: input.leftReply, lastUser: input.leftUser },
      { role: 'B', label: String(input.rightLabel || 'Right window'), last: input.rightReply, lastUser: input.rightUser }
    ];
    const lines = [
      'Two chat windows are connected, A and B.',
      'A = "' + sides[0].label + '", B = "' + sides[1].label + '".'
    ];
    for (const side of sides) {
      lines.push('');
      lines.push(side.role + ' (' + side.label + '):');
      lines.push('  The user last said: ' + (clip(side.lastUser || '(nothing yet)', 400) || '(nothing yet)'));
      lines.push('  The AI last answered: ' + (clip(side.last || '(nothing yet)', TEXT_LIMIT) || '(nothing yet)'));
    }
    lines.push('');
    lines.push('Which window is the brain (it gives the instructions and plans) and ' +
      'which is the worker (it does the work)?');
    lines.push('Answer with JSON only, in exactly this shape:');
    lines.push('{"brain":"A" or "B","confidence":"high","reason":"one short sentence"}');
    return lines.join('\n');
  }

  // Read the model's answer to the role question. Never guesses.
  function parseRoleAnswer(text) {
    const value = parseJsonObject(text);
    if (!value) {
      return { ok: false, error: 'The API answer was not in the shape that was asked for.' };
    }
    const raw = String(value.brain == null ? '' : value.brain).trim().toUpperCase();
    const brain = raw === 'A' || raw === 'LEFT' ? 'A' : (raw === 'B' || raw === 'RIGHT' ? 'B' : '');
    if (!brain) {
      return {
        ok: false,
        error: 'The API could not tell which window is the brain.',
        reason: oneLine(value.reason, 200)
      };
    }
    const confidence = String(value.confidence == null ? '' : value.confidence).trim().toLowerCase();
    return {
      ok: true,
      brain: brain,
      worker: brain === 'A' ? 'B' : 'A',
      confidence: confidence || 'unknown',
      reason: oneLine(value.reason, 200)
    };
  }

  // Which window looks like the brain? Returns
  //   { ok:true, brain:'A'|'B', worker, confidence, reason, provider }
  //   { ok:false, error, skipped? }   nothing is changed on failure
  // It never throws.
  async function detectRoles(input, deps) {
    const settings = (deps && deps.settings) || {};
    if (!on(settings, 'roles')) return { ok: false, skipped: true, error: 'Auto detect is off.' };
    const askFn = deps && typeof deps.ask === 'function' ? deps.ask : ask;
    const result = await askFn(buildRolePrompt(input || {}), PROMPTS.roles, deps);
    if (!result.ok) return { ok: false, error: result.error, skipped: Boolean(result.skipped) };
    const parsed = parseRoleAnswer(result.text);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, note: parsed.reason, provider: result.provider };
    }
    return Object.assign({}, parsed, { provider: result.provider });
  }

  // A short sentence for the popup, for example
  // "Right window looks like the brain (arena.ai/agent)."
  function roleSentence(result, sides) {
    if (!result || !result.ok) return '';
    const labels = sides || {};
    const brainLabel = labels[result.brain] || ('Tab ' + result.brain);
    const workerLabel = labels[result.worker] || ('Tab ' + result.worker);
    return brainLabel + ' looks like the brain, so ' + workerLabel + ' becomes the worker ' +
      '(Tab B). ' + (result.reason ? result.reason : '');
  }

  // ---------- part 2: the best answer card ----------
  // Build the question for "which answer card is the best one?".
  function buildBestPrompt(input) {
    const cards = Array.isArray(input.cards) ? input.cards : [];
    const lines = [
      'The chat window "' + String(input.title || 'a chat') + '" showed ' + cards.length +
        ' answer cards for the same turn.',
      'Project goal: ' + (clip(input.goal, 600) || '(no goal was typed)')
    ];
    if (input.question) {
      lines.push('What was asked: ' + clip(input.question, 600));
    }
    lines.push('');
    cards.forEach(function (card, index) {
      lines.push('Card ' + (index + 1) + ':');
      lines.push(clip(card.text, CARD_LIMIT));
      lines.push('');
    });
    lines.push('Which card is the best one for the project goal? Answer with JSON only, in exactly this shape:');
    lines.push('{"best":' + (cards.length > 1 ? '2' : '1') + ',"reason":"one short sentence"}');
    lines.push('"best" is the card number: 1 to ' + Math.max(1, cards.length) + '.');
    return lines.join('\n');
  }

  // Read the model's choice of card. Returns a 0-based index.
  function parseBestAnswer(text, cardCount) {
    const value = parseJsonObject(text);
    const count = Math.max(0, Number(cardCount) || 0);
    if (!value) {
      return { ok: false, error: 'The API answer was not in the shape that was asked for.' };
    }
    const number = Math.round(Number(value.best));
    if (!Number.isFinite(number) || number < 1 || number > count) {
      return {
        ok: false,
        error: 'The API chose a card that does not exist.',
        reason: oneLine(value.reason, 200)
      };
    }
    return {
      ok: true,
      index: number - 1,
      reason: oneLine(value.reason, 200) || 'no reason given'
    };
  }

  // Choose the best card of a group. Returns
  //   { ok:true, index, reason, provider }            the card to forward
  //   { ok:false, error, skipped? }                   nothing is chosen
  // With a single card the API is never called: there is nothing to choose.
  async function chooseBestCard(input, deps) {
    const settings = (deps && deps.settings) || {};
    const cards = (input && Array.isArray(input.cards) ? input.cards : [])
      .filter(function (card) { return card && String(card.text || '').trim(); });
    if (cards.length <= 1) {
      return {
        ok: true,
        index: 0,
        reason: 'there is only one answer',
        provider: null,
        skippedApi: true
      };
    }
    if (!on(settings, 'best')) return { ok: false, skipped: true, error: 'Pick the best answer is off.' };
    const askFn = deps && typeof deps.ask === 'function' ? deps.ask : ask;
    const result = await askFn(buildBestPrompt({
      goal: input.goal,
      title: input.title,
      question: input.question,
      cards: cards
    }), PROMPTS.best, deps);
    if (!result.ok) return { ok: false, error: result.error, skipped: Boolean(result.skipped) };
    const parsed = parseBestAnswer(result.text, cards.length);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, note: parsed.reason, provider: result.provider };
    }
    return {
      ok: true,
      index: parsed.index,
      reason: parsed.reason,
      provider: result.provider,
      cards: cards
    };
  }

  // One short log line: "Smart Helper (Gemini) chose card 2 of 3: card 2 has more detail."
  function bestCardLine(result, cardCount) {
    const count = Math.max(1, Number(cardCount) || 1);
    if (!result || !result.ok) return '';
    if (result.skippedApi) return 'Smart Helper: only one answer, so no choice was needed.';
    return 'Smart Helper (' + providerName(result.provider) + ') chose card ' +
      (result.index + 1) + ' of ' + count + ': ' + result.reason;
  }

  // ---------- part 3: is the project finished? ----------
  // Build the question for "is the project done?".
  function buildStopPrompt(input) {
    const goal = clip(input.goal, 1000);
    const messages = recentMessages(input.messages, MESSAGES_LIMIT);
    const lines = [
      'Project goal: ' + (goal || '(no goal was typed)'),
      '',
      'The last messages between the two chats, oldest first:',
      messages.length ? transcript(messages) : '(there are no messages yet)',
      '',
      'Is the project finished? Answer with DONE or CONTINUE and one short reason, ' +
        'in exactly this shape: {"done":true,"reason":"one short sentence"}',
      'Use "done":false when the work is clearly not finished yet.'
    ];
    return lines.join('\n');
  }

  // Read the model's DONE / CONTINUE answer. Only an explicit "done" stops
  // the loop: a muddled answer keeps the run going, which is the safe side.
  function parseStopAnswer(text) {
    const source = String(text == null ? '' : text).trim();
    if (!source) return { ok: false, error: 'The API sent an empty answer.' };
    const value = parseJsonObject(source);
    if (value && typeof value.done === 'boolean') {
      return {
        ok: true,
        done: value.done,
        reason: oneLine(value.reason, 200) || (value.done ? 'the project is finished' : 'not finished yet')
      };
    }
    // A model that ignored the JSON instruction but said DONE plainly is fine.
    const verdict = source.toUpperCase().match(/\b(DONE|CONTINUE)\b/);
    if (verdict) {
      const reason = oneLine(source.replace(/\b(DONE|CONTINUE)\b/i, '').replace(/^[\s:,.–-]+/, ''), 200);
      return {
        ok: true,
        done: verdict[1] === 'DONE',
        reason: reason || (verdict[1] === 'DONE' ? 'the project is finished' : 'not finished yet')
      };
    }
    return { ok: false, error: 'The API did not say DONE or CONTINUE.' };
  }

  // After a round: ask whether the project is finished. Returns
  //   { checked:true, done:true,  stopText:'...' }  stop the loop
  //   { checked:true, done:false, log:'...' }        keep going
  //   { checked:false, why:'...' }                   skipped (no goal, off, no calls left)
  // It never throws.
  async function shouldStop(input, deps) {
    const settings = (deps && deps.settings) || {};
    // The caller can pass its own ask() so every call is logged the same way.
    const askFn = deps && typeof deps.ask === 'function' ? deps.ask : ask;
    if (!on(settings, 'stop')) return { checked: false, why: 'Auto stop is off.' };
    const goal = String(input && input.goal || '').trim();
    if (!goal) return { checked: false, why: 'The project goal is empty.' };
    const round = Number(input && input.round) || 0;
    const every = Math.max(1, Math.round(Number(settings.helperStopEvery) || 1));
    if (round % every !== 0) {
      return { checked: false, why: 'Checked every ' + every + ' rounds.' };
    }

    const result = await askFn(
      buildStopPrompt({ goal: goal, messages: input.messages }),
      PROMPTS.stop,
      deps
    );
    if (!result.ok) {
      return { checked: false, why: result.error, skipped: Boolean(result.skipped) };
    }
    const parsed = parseStopAnswer(result.text);
    const provider = providerName(result.provider);
    if (!parsed.ok) {
      return {
        checked: false,
        why: 'The Smart Helper could not tell whether the project is finished: ' + parsed.error,
        provider: provider
      };
    }
    if (parsed.done) {
      return {
        checked: true,
        done: true,
        provider: provider,
        reason: parsed.reason,
        stopText: 'Stopped by the Smart Helper: ' + parsed.reason + ' (' + provider + ')'
      };
    }
    return {
      checked: true,
      done: false,
      provider: provider,
      reason: parsed.reason,
      log: 'Smart Helper (' + provider + '): not finished yet — ' + parsed.reason
    };
  }

  // After a round: should this round be checked at all? Used by the loop to
  // skip the call without asking the API.
  function stopCheckDue(settings, round) {
    if (!on(settings, 'stop')) return false;
    if (!String(settings.goal || '').trim()) return false;
    const every = Math.max(1, Math.round(Number(settings.helperStopEvery) || 1));
    return (Number(round) || 0) % every === 0;
  }

  function providerName(provider) {
    return provider === 'grok' ? 'Grok' : (provider === 'gemini' ? 'Gemini' : 'the API');
  }

  // A plain sentence for the log when a helper call fails or is skipped.
  function helperLogLine(job, result) {
    const name = jobName(job);
    if (!result) return name + ': nothing happened.';
    if (result.skipped) return 'Smart Helper: ' + result.error + ' (' + name + ')';
    return 'Smart Helper (' + name + ') could not answer: ' + result.error +
      ' The normal loop carries on.';
  }

  function jobName(job) {
    if (job === 'roles') return 'auto detect brain and worker';
    if (job === 'best') return 'pick the best answer';
    if (job === 'stop') return 'auto stop when done';
    return 'Smart Helper';
  }

  // ---------- the call budget ----------
  // One counter per run. take() answers "may I make one more call?" and
  // remembers the answer, so the limit can never be exceeded.
  function createBudget(limit) {
    const max = limit === undefined ? DEFAULT_MAX_CALLS : Math.max(0, Math.round(Number(limit)) || 0);
    return {
      limit: max,
      used: 0,
      take: function take() {
        if (this.used >= this.limit) return false;
        this.used += 1;
        return true;
      },
      left: function left() {
        return Math.max(0, this.limit - this.used);
      }
    };
  }

  return {
    DEFAULT_MAX_CALLS,
    MESSAGES_LIMIT,
    PARTS,
    PROMPTS,
    TEXT_LIMIT,
    anyPartOn,
    ask,
    bestCardLine,
    buildBestPrompt,
    buildRolePrompt,
    buildStopPrompt,
    chooseBestCard,
    clip,
    createBudget,
    detectRoles,
    helperLogLine,
    jobName,
    maxCalls,
    on,
    oneLine,
    parseBestAnswer,
    parseJsonObject,
    parseRoleAnswer,
    parseStopAnswer,
    providerName,
    recentMessages,
    roleSentence,
    shouldStop,
    stopCheckDue,
    transcript
  };
});
