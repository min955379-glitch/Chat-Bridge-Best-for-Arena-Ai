// extract.js — turns a full AI reply into the part the user wants to forward.
// Works on a real page element (tab to tab mode) and on plain text (API mode).
// This file is plain JavaScript with no dependencies, so it can be loaded in
// a content script, in the background service worker, or in Node for tests.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatBridgeExtract = api;
})(typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  const MODES = { FULL: 'full', CODE: 'code', MARKERS: 'markers' };
  const MODE_LABELS = {
    full: 'Full reply',
    code: 'Last code block',
    markers: 'Between markers'
  };

  // Make text consistent: Windows line endings are changed to normal newlines.
  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  }

  // Read text that the user can actually see. innerText respects line breaks
  // and hidden elements; textContent is the fallback in simple test pages.
  function visibleText(el) {
    if (!el) return '';
    const inner = el.innerText;
    if (typeof inner === 'string' && inner.trim() !== '') return inner;
    return el.textContent || '';
  }

  function markersOf(markers) {
    const start = (markers && String(markers.start).trim()) || 'START';
    const end = (markers && String(markers.end).trim()) || 'END';
    return { start: start, end: end };
  }

  // Text between the LAST start marker and the first end marker after it.
  function betweenMarkers(text, markers) {
    const pair = markersOf(markers);
    const source = String(text == null ? '' : text);
    const startAt = source.lastIndexOf(pair.start);
    if (startAt === -1) {
      return {
        error: 'I could not find the START marker "' + pair.start + '" in the last reply. ' +
          'Tell the AI to put that word where the part you want to forward begins.'
      };
    }
    const afterStart = startAt + pair.start.length;
    const endAt = source.indexOf(pair.end, afterStart);
    if (endAt === -1) {
      return {
        error: 'I found the START marker but no END marker "' + pair.end + '" after it in the last reply.'
      };
    }
    const value = cleanText(source.slice(afterStart, endAt));
    if (!value) return { error: 'The text between the START and END markers is empty.' };
    return { text: value };
  }

  // Last fenced code block in plain text (API answers arrive as markdown).
  function lastCodeFromText(text) {
    const source = String(text == null ? '' : text);
    const re = /```[^\n`]*\n?([\s\S]*?)```/g;
    let match;
    let last = null;
    while ((match = re.exec(source)) !== null) last = match[1];
    if (last === null) return { error: 'No code block found in the last reply.' };
    const value = cleanText(last);
    if (!value) return { error: 'The last code block in the reply is empty.' };
    return { text: value };
  }

  // Last <pre><code> (or <pre>) inside the reply element.
  function lastCodeFromElement(el) {
    if (!el) return { error: 'No code block found in the last reply.' };
    const blocks = el.querySelectorAll('pre code, pre');
    if (!blocks.length) return { error: 'No code block found in the last reply.' };
    const last = blocks[blocks.length - 1];
    const holder = last.tagName === 'PRE' && last.querySelector('code') ? last.querySelector('code') : last;
    const value = cleanText(visibleText(holder));
    if (!value) return { error: 'The last code block in the reply is empty.' };
    return { text: value };
  }

  // mode first, plain text second.
  function applyModeToText(text, mode, markers) {
    const full = cleanText(text);
    if (!full) return { error: 'The reply is empty.' };
    if (mode === MODES.CODE) return lastCodeFromText(full);
    if (mode === MODES.MARKERS) return betweenMarkers(full, markers);
    return { text: full };
  }

  function applyModeToElement(el, mode, markers) {
    const full = cleanText(visibleText(el));
    if (!full) return { error: 'The last reply is empty right now.' };
    if (mode === MODES.CODE) return lastCodeFromElement(el);
    if (mode === MODES.MARKERS) return betweenMarkers(full, markers);
    return { text: full };
  }

  // True when a reply still looks unfinished, for example a code block that
  // has an opening fence but no closing fence yet. This is an extra safety net
  // on top of the "seconds of silence" setting.
  function looksUnfinished(text) {
    const source = String(text == null ? '' : text);
    const fences = source.match(/```/g);
    return Boolean(fences && fences.length % 2 === 1);
  }

  // Short version of a text, used by "Test copy" in the popup.
  function preview(text, max) {
    const value = cleanText(text);
    const limit = max || 200;
    return value.length > limit ? value.slice(0, limit) + '…' : value;
  }

  return {
    MODES,
    MODE_LABELS,
    applyModeToElement,
    applyModeToText,
    betweenMarkers,
    cleanText,
    looksUnfinished,
    preview,
    visibleText
  };
});
