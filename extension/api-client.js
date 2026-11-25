// api-client.js — talks to the Google Gemini API and the xAI Grok API,
// with automatic fallback when one of them fails.
// Plain JavaScript, no dependencies. Works in the background worker and in Node
// (for tests) through the small wrapper at the top.
//
// Provider details (checked against the official docs, November 2026):
//   Gemini: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//           header: x-goog-api-key
//           body:   { systemInstruction: { parts: [{ text }] },
//                     contents: [{ role: "user"|"model", parts: [{ text }] }] }
//           answer: candidates[0].content.parts[].text
//   Grok:   POST https://api.x.ai/v1/chat/completions   (OpenAI compatible)
//           header: Authorization: Bearer <key>
//           body:   { model, messages: [{ role, content }] }
//           answer: choices[0].message.content
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatBridgeApi = api;
})(typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const GROK_URL = 'https://api.x.ai/v1/chat/completions';
  const REQUEST_TIMEOUT_MS = 120000; // an API answer may take a while
  const COOLDOWN_MS = 60000;         // a rate limited provider rests 60 seconds
  const RETRY_WAIT_MS = 2000;        // wait before the single retry

  // When each provider may be used again (a timestamp per provider).
  // It lives at module level so a 429 in one round is remembered in the next.
  // A run can pass its own object in deps.cooldowns to keep it per run.
  const sharedCooldowns = { gemini: 0, grok: 0 };

  // Read the cooldown table: the one from the caller when given, else the
  // shared one. Missing entries are created, so callers can pass {}.
  function cooldownsFrom(deps) {
    const table = deps && deps.cooldowns;
    if (!table || typeof table !== 'object') return sharedCooldowns;
    if (typeof table.gemini !== 'number') table.gemini = 0;
    if (typeof table.grok !== 'number') table.grok = 0;
    return table;
  }

  function providerLabel(provider) {
    return provider === 'grok' ? 'Grok' : 'Gemini';
  }

  function makeError(message, extra) {
    return Object.assign(new Error(message), extra || {});
  }

  // One HTTP call, with a timeout so a stuck request cannot freeze the loop.
  async function postJson(fetchFn, url, headers, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      let data = null;
      let text = '';
      try {
        text = await response.text();
        data = text ? JSON.parse(text) : null;
      } catch (err) {
        data = null;
      }
      return { status: response.status, ok: response.ok, data: data, text: text };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Turn an HTTP status into a short, plain explanation.
  function explainStatus(status) {
    if (status === 429) return 'the free quota or rate limit is used up';
    if (status === 401 || status === 403) return 'the API key was rejected';
    if (status === 404) return 'the model name was not found';
    if (status === 400) return 'the request was refused';
    if (status >= 500) return 'the service is having problems';
    return 'the server refused the request';
  }

  // Read the answer text out of a Gemini response. Throws if there is no text.
  function readGeminiText(data) {
    const candidate = data && data.candidates && data.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const text = parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('').trim();
    if (text) return text;
    const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
    if (blocked) throw makeError('Gemini refused to answer (reason: ' + blocked + ').', { kind: 'empty' });
    const reason = candidate && candidate.finishReason;
    throw makeError('Gemini sent no text back' + (reason ? ' (finish reason: ' + reason + ')' : '') + '.',
      { kind: 'empty' });
  }

  // Read the answer text out of a Grok (OpenAI style) response.
  function readGrokText(data) {
    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    const reason = choice && choice.finish_reason;
    throw makeError('Grok sent no text back' + (reason ? ' (finish reason: ' + reason + ')' : '') + '.',
      { kind: 'empty' });
  }

  function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
      .map((m) => ({ role: m.role, content: String(m.content) }));
  }

  // Gemini request body. Gemini calls the assistant role "model".
  function buildGeminiRequest(model, messages, systemPrompt) {
    const contents = normalizeMessages(messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    const body = { contents: contents };
    if (systemPrompt && String(systemPrompt).trim()) {
      body.systemInstruction = { parts: [{ text: String(systemPrompt) }] };
    }
    const safeModel = String(model || 'gemini-2.5-flash').trim().replace(/^models\//, '');
    return { url: GEMINI_BASE + encodeURIComponent(safeModel) + ':generateContent', body: body };
  }

  // Grok request body, in the OpenAI chat format.
  function buildGrokRequest(model, messages, systemPrompt) {
    const list = [];
    if (systemPrompt && String(systemPrompt).trim()) {
      list.push({ role: 'system', content: String(systemPrompt) });
    }
    for (const m of normalizeMessages(messages)) list.push({ role: m.role, content: m.content });
    return {
      url: GROK_URL,
      body: { model: String(model || 'grok-4').trim(), messages: list, stream: false }
    };
  }

  // Short wait that the tests can switch off.
  function wait(ms, deps) {
    const delay = deps && typeof deps.sleep === 'function'
      ? deps.sleep
      : (t) => new Promise((resolve) => setTimeout(resolve, t));
    return deps && deps.retryWaitMs === 0 ? Promise.resolve() : delay(ms);
  }

  // One turn of an API chat with automatic fallback.
  //   messages : the conversation so far; the last item is the new question
  //   settings : { provider, geminiKey, geminiModel, grokKey, grokModel, systemPrompt }
  //   deps     : { fetch, now, sleep, cooldownMs, retryWaitMs }  (all optional)
  // Returns { text, provider, fellBack, notes }.
  // The notes are plain-English lines for the popup log.
  // Throws a plain Error if both providers fail.
  async function requestWithFallback(messages, settings, deps) {
    const d = deps || {};
    const fetchFn = d.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const now = typeof d.now === 'function' ? d.now : Date.now;
    const cooldownMs = typeof d.cooldownMs === 'number' ? d.cooldownMs : COOLDOWN_MS;
    if (!fetchFn) throw new Error('This browser cannot contact the API. Please use Chrome.');

    const primary = settings.provider === 'grok' ? 'grok' : 'gemini';
    const secondary = primary === 'grok' ? 'gemini' : 'grok';
    const notes = [];
    const keys = {
      gemini: String(settings.geminiKey || '').trim(),
      grok: String(settings.grokKey || '').trim()
    };
    const models = { gemini: settings.geminiModel, grok: settings.grokModel };

    // Providers that hit a 429 rest for 60 seconds before being used again.
    // This table is NOT created here: it outlives a single request, so the
    // second round already knows that Gemini is resting.
    const cooldownUntil = cooldownsFrom(d);

    // One HTTP attempt with one provider. Throws a plain Error on any problem.
    async function attempt(provider) {
      const label = providerLabel(provider);
      const isGemini = provider === 'gemini';
      const req = isGemini
        ? buildGeminiRequest(models.gemini, messages, settings.systemPrompt)
        : buildGrokRequest(models.grok, messages, settings.systemPrompt);
      const headers = isGemini ? { 'x-goog-api-key': keys[provider] } : { Authorization: 'Bearer ' + keys[provider] };
      let res;
      try {
        res = await postJson(fetchFn, req.url, headers, req.body);
      } catch (err) {
        const timedOut = err && err.name === 'AbortError';
        throw makeError(label + (timedOut ? ' timed out after 2 minutes.' : ' could not be reached (network problem).'),
          { kind: 'network' });
      }
      if (!res.ok) {
        throw makeError(label + ' could not answer: ' + explainStatus(res.status) + ' (HTTP ' + res.status + ').',
          { kind: 'http', status: res.status });
      }
      return isGemini ? readGeminiText(res.data) : readGrokText(res.data);
    }

    // Use a provider: once, and once more after 2 seconds if it failed.
    async function tryProvider(provider) {
      const label = providerLabel(provider);
      if (now() < cooldownUntil[provider]) {
        const seconds = Math.ceil((cooldownUntil[provider] - now()) / 1000);
        throw makeError(label + ' is resting after a rate limit (' + seconds + 's left).', { kind: 'cooldown' });
      }
      if (!keys[provider]) {
        throw makeError('No API key saved for ' + label + '.', { kind: 'nokey' });
      }
      let lastError = null;
      for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
        try {
          const text = await attempt(provider);
          if (text) return text;
          lastError = makeError(label + ' sent an empty answer.', { kind: 'empty' });
        } catch (err) {
          lastError = err;
        }
        if (lastError.kind === 'nokey') break;
        if (lastError.status === 429) {
          cooldownUntil[provider] = now() + cooldownMs;
          notes.push(label + ' hit the rate limit, so it will rest 60 seconds.');
          break; // a rate limit will not clear by retrying right away
        }
        if (attemptNo === 1) {
          notes.push(lastError.message + ' Trying once more...');
          await wait(RETRY_WAIT_MS, d);
        }
      }
      throw lastError || makeError(label + ' did not answer.', { kind: 'empty' });
    }

    // First choice.
    try {
      const text = await tryProvider(primary);
      return { text: text, provider: primary, fellBack: false, notes: notes };
    } catch (err) {
      if (err.kind === 'nokey' && !keys[secondary]) {
        throw new Error('No API key saved for ' + providerLabel(primary) +
          '. Please add your API key in the Settings section.');
      }
      notes.push(err.message);
      notes.push('Switching to the backup provider (' + providerLabel(secondary) + ').');
    }

    // Second choice.
    try {
      const text = await tryProvider(secondary);
      notes.push('The answer came from ' + providerLabel(secondary) + ' instead.');
      return { text: text, provider: secondary, fellBack: true, notes: notes };
    } catch (err) {
      throw new Error('Both API providers failed. ' + notes.join(' ') + ' ' + err.message);
    }
  }

  return {
    COOLDOWN_MS,
    GEMINI_BASE,
    sharedCooldowns,
    GROK_URL,
    REQUEST_TIMEOUT_MS,
    RETRY_WAIT_MS,
    buildGeminiRequest,
    buildGrokRequest,
    explainStatus,
    providerLabel,
    requestWithFallback
  };
});
