// common.js — small helpers shared by the popup, the background worker
// and the content script.
// Plain JavaScript, no dependencies. Also loadable in Node for the tests.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatBridgeCommon = api;
})(typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  const COPY_MODES = ['full', 'code', 'markers'];
  const PROVIDERS = ['gemini', 'grok'];

  // Every setting with its default value. The popup saves the whole object
  // under the storage key "settings"; missing values fall back to these.
  const DEFAULTS = {
    rounds: 5,
    maxRounds: 100,
    silence: 8,
    timeout: 600,
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
    geminiKey: '',
    geminiModel: 'gemini-2.5-flash',
    grokKey: '',
    grokModel: 'grok-4',
    memory: 6,
    systemPrompt: ''
  };

  function clampInt(value, min, max, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function cleanString(value, fallback) {
    const s = value === null || value === undefined ? '' : String(value);
    return s.trim() === '' ? (fallback === undefined ? '' : fallback) : s;
  }

  // Make sure a settings object is complete and inside the allowed ranges.
  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = Object.assign({}, DEFAULTS);
    out.rounds = clampInt(src.rounds, 1, 100, DEFAULTS.rounds);
    out.maxRounds = clampInt(src.maxRounds, 1, 100, DEFAULTS.maxRounds);
    out.silence = clampInt(src.silence, 2, 120, DEFAULTS.silence);
    out.timeout = clampInt(src.timeout, 30, 3600, DEFAULTS.timeout);
    out.memory = clampInt(src.memory, 0, 30, DEFAULTS.memory);
    out.copyModeA = COPY_MODES.includes(src.copyModeA) ? src.copyModeA : DEFAULTS.copyModeA;
    out.copyModeB = COPY_MODES.includes(src.copyModeB) ? src.copyModeB : DEFAULTS.copyModeB;
    out.markerStart = cleanString(src.markerStart, DEFAULTS.markerStart);
    out.markerEnd = cleanString(src.markerEnd, DEFAULTS.markerEnd);
    out.prefix = src.prefix === null || src.prefix === undefined ? '' : String(src.prefix);
    out.suffix = src.suffix === null || src.suffix === undefined ? '' : String(src.suffix);
    out.stopIfSame = Boolean(src.stopIfSame);
    out.stopWord = cleanString(src.stopWord, '');
    out.mode = src.mode === 'api' ? 'api' : 'tab';
    out.provider = PROVIDERS.includes(src.provider) ? src.provider : DEFAULTS.provider;
    out.geminiKey = cleanString(src.geminiKey, '');
    out.geminiModel = cleanString(src.geminiModel, DEFAULTS.geminiModel);
    out.grokKey = cleanString(src.grokKey, '');
    out.grokModel = cleanString(src.grokModel, DEFAULTS.grokModel);
    out.systemPrompt = src.systemPrompt === null || src.systemPrompt === undefined ? '' : String(src.systemPrompt);
    return out;
  }

  // How many rounds will really run (never more than the safety cap or 100).
  function effectiveRounds(settings) {
    const rounds = clampInt(settings.rounds, 1, 100, DEFAULTS.rounds);
    const cap = clampInt(settings.maxRounds, 1, 100, DEFAULTS.maxRounds);
    return Math.min(rounds, cap, 100);
  }

  // Site key = origin + "/" + first path segment, for example
  // "https://arena.ai/c" or "https://arena.ai/agent". Picks are saved per key.
  function siteKeyFor(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return '';
    }
    if (!parsed.host) return '';
    const origin = parsed.origin && parsed.origin !== 'null'
      ? parsed.origin
      : parsed.protocol + '//' + parsed.host;
    const segments = parsed.pathname.split('/').filter(Boolean);
    return origin + '/' + (segments.length ? segments[0] : '');
  }

  // Friendly site name for the popup, for example "arena.ai/c".
  function siteLabel(url) {
    try {
      const parsed = new URL(url);
      const segment = parsed.pathname.split('/').filter(Boolean)[0];
      return parsed.hostname + (segment ? '/' + segment : '');
    } catch (err) {
      return 'this page';
    }
  }

  function pickStorageKey(siteKey) {
    return 'site_' + siteKey;
  }

  // Only normal web pages can be picked and pasted into.
  function isSupportedUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  // Add the prefix and suffix around a message that is being forwarded.
  function wrapMessage(prefix, text, suffix) {
    const start = String(prefix || '').trim();
    const end = String(suffix || '').trim();
    const body = String(text === null || text === undefined ? '' : text).trim();
    return [start, body, end].filter(function (part) { return part !== ''; }).join('\n\n');
  }

  function providerLabel(provider) {
    return provider === 'grok' ? 'Grok' : 'Gemini';
  }

  function otherProvider(provider) {
    return provider === 'grok' ? 'gemini' : 'grok';
  }

  function hasProviderKey(settings, provider) {
    return provider === 'gemini'
      ? Boolean(String(settings.geminiKey || '').trim())
      : Boolean(String(settings.grokKey || '').trim());
  }

  // Never show or log an API key, even if a server echoes it back.
  function hideSecret(text, settings) {
    let out = String(text === null || text === undefined ? '' : text);
    const keys = [settings && settings.geminiKey, settings && settings.grokKey]
      .map(function (k) { return String(k || '').trim(); })
      .filter(function (k) { return k.length >= 6; });
    for (const key of keys) out = out.split(key).join('[hidden key]');
    return out;
  }

  function formatClock(timestamp) {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (err) {
      return '';
    }
  }

  return {
    COPY_MODES,
    DEFAULTS,
    PROVIDERS,
    clampInt,
    effectiveRounds,
    formatClock,
    hasProviderKey,
    hideSecret,
    isSupportedUrl,
    normalizeSettings,
    otherProvider,
    pickStorageKey,
    providerLabel,
    siteKeyFor,
    siteLabel,
    wrapMessage
  };
});
