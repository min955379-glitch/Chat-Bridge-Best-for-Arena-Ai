// content.js — runs inside every web page (see manifest.json).
// Four jobs:
//   1. Picker: the user clicks the chat box, the send button and the AI reply;
//      the extension saves a CSS selector for each spot.
//   2. Paste text into the chat box and press send.
//   3. Read the last AI reply, so the background worker can forward it.
//   4. Answer small requests from the popup ("Test copy", "Test paste").
// Plain JavaScript, no frameworks. Written so a second injection is harmless.
(function () {
  'use strict';

  // ---------- double injection guard ----------
  if (window.__chatBridgeLoaded) return;
  window.__chatBridgeLoaded = true;

  const Selectors = window.ChatBridgeSelectors;
  const Extract = window.ChatBridgeExtract;
  const Common = window.ChatBridgeCommon;
  if (!Selectors || !Extract || !Common) {
    // The helper files are listed before this file in the manifest, so this
    // should never happen. Say so once instead of crashing the page.
    console.warn('Chat Bridge: helper files are missing, so the extension is off on this page.');
    return;
  }

  const PICK_KEY_PREFIX = 'site_';
  const PASTE_WAIT_MS = 700;    // pause between pasting and pressing send
  const ENABLE_WAIT_MS = 5000;  // how long a disabled send button may stay disabled
  const KIND_NAMES = { input: 'chat box', send: 'send button', reply: 'AI reply' };

  let picking = null; // the running picker, or null

  // ---------- tiny helpers ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const siteKey = () => Common.siteKeyFor(location.href);

  // The tab id, so the background worker can hand us picks saved for this tab.
  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    if (typeof element.getClientRects !== 'function') return true;
    return element.getClientRects().length > 0;
  }

  // Scroll an element into view without breaking on old browsers.
  function scrollIntoViewSafely(element) {
    if (!element || typeof element.scrollIntoView !== 'function') return;
    try {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (err) {
      try { element.scrollIntoView(); } catch (ignored) { /* nothing to do */ }
    }
  }

  // ---------- saved picks ----------
  async function readPicks(key) {
    const name = PICK_KEY_PREFIX + key;
    const stored = await chrome.storage.local.get(name);
    return stored[name] || null;
  }

  // ---------- finding things on the page ----------
  // Every element that matches the reply selector, in page order.
  function replyMatches(selector) {
    const all = Selectors.queryAll(document, selector);
    const visible = all.filter(isVisible);
    return visible.length ? visible : all;
  }

  function isEditable(element) {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const type = String(element.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'url', 'email', ''].includes(type);
    }
    return element.isContentEditable || element.getAttribute('role') === 'textbox' ||
      element.getAttribute('contenteditable') === 'true';
  }

  // Find a saved element. If the selector no longer matches, try the point the
  // user clicked: many sites only change the outer wrapper during a redesign.
  function findSaved(pick) {
    if (!pick || !pick.selector) return null;
    const matches = Selectors.queryAll(document, pick.selector);
    if (matches.length) {
      if (pick.kind === 'reply') return matches[matches.length - 1];
      return matches.find(isVisible) || matches[0];
    }
    if (typeof pick.x !== 'number' || typeof pick.y !== 'number') return null;
    let element = document.elementFromPoint(pick.x, pick.y);
    if (!element) return null;
    // Walk up only if the saved pick was a button or a box.
    if (pick.kind === 'send') element = element.closest('button, [role="button"], a') || element;
    return element;
  }

  // The chat box itself: the saved element or the nearest editable inside it.
  const EDITABLE_SELECTOR = 'textarea, input[type="text"], input:not([type]), ' +
    '[contenteditable="true"], [contenteditable=""], [role="textbox"]';

  function chatBoxFrom(pick) {
    const saved = findSaved(pick);
    if (!saved) return null;
    if (isEditable(saved)) return saved;
    // The user probably clicked a wrapper around the real box (a rounded
    // border, a toolbar). Look inside first, then just outside.
    const inside = saved.querySelector(EDITABLE_SELECTOR);
    if (inside) return inside;
    const parent = saved.parentElement;
    const nextTo = parent ? parent.querySelector(EDITABLE_SELECTOR) : null;
    if (nextTo) return nextTo;
    return saved.isContentEditable ? saved : null;
  }

  // The send button itself: the saved element or the nearest button inside it.
  function sendButtonFrom(pick) {
    const saved = findSaved(pick);
    if (!saved) return null;
    if (typeof saved.matches === 'function' && saved.matches('button, [role="button"], a')) return saved;
    const inside = saved.querySelector('button, [role="button"], a');
    return inside || saved;
  }

  // ---------- reading a reply ----------
  // Full text of the newest reply + how many replies match + last code block.
  function readLastReply(selector) {
    const list = replyMatches(selector);
    if (!list.length) {
      return {
        ok: false,
        count: 0,
        error: 'The AI reply was not found on the page. The page may have changed, so please pick the AI reply again.'
      };
    }
    const element = list[list.length - 1];
    const text = Extract.cleanText(Extract.visibleText(element));
    let code = '';
    const blocks = element.querySelectorAll('pre code, pre');
    if (blocks.length) {
      const last = blocks[blocks.length - 1];
      const holder = last.tagName === 'PRE' && last.querySelector('code') ? last.querySelector('code') : last;
      code = Extract.cleanText(Extract.visibleText(holder));
    }
    return { ok: true, count: list.length, text: text, code: code };
  }

  // ---------- pasting and sending ----------
  // React and Vue only notice a value change made through the native setter.
  function setNativeValue(box, text) {
    const proto = box.tagName.toLowerCase() === 'textarea'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(box, text);
    else box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectAllContent(box) {
    try {
      const range = document.createRange();
      range.selectNodeContents(box);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (err) {
      // Some editors refuse ranges. The delete command below still works.
    }
  }

  // Type into a contenteditable editor (ProseMirror, Lexical, Quill, ...).
  async function insertIntoEditable(box, text) {
    box.focus();
    await sleep(40);
    selectAllContent(box);
    await sleep(20);
    document.execCommand('delete');
    await sleep(20);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (err) {
      inserted = false;
    }
    // Did something actually arrive? Compare loosely: editors often change
    // spacing, and a real insertion must not be overwritten just because a
    // newline became a <div>.
    const written = boxText(box).replace(/\s+/g, ' ').trim();
    const expected = String(text).replace(/\s+/g, ' ').trim();
    const looksWritten = written.length >= Math.min(4, expected.length) &&
      (expected.startsWith(written.slice(0, 20)) || written.includes(expected.slice(0, 20)));
    if (!inserted || !looksWritten) {
      // Last resort: write the text directly, then tell the site about it.
      box.textContent = text;
      box.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true, inputType: 'insertText', data: text
      }));
    }
  }

  function boxText(box) {
    if (!box) return '';
    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') return String(box.value || '');
    return String(box.innerText || box.textContent || '');
  }

  function isDisabled(button) {
    if (!button) return false;
    return button.disabled === true ||
      button.getAttribute('aria-disabled') === 'true' ||
      button.getAttribute('data-disabled') === 'true';
  }

  async function waitUntilEnabled(button, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (isDisabled(button) && Date.now() < deadline) await sleep(200);
    return !isDisabled(button);
  }

  function pressEnter(box) {
    const options = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    const editor = box.isContentEditable ? box : (box.closest('[contenteditable="true"]') || box);
    // Send the key once per element: when the box is the editor itself, the
    // list has one entry, so the site does not receive Enter twice.
    const targets = editor === box ? [box] : [box, editor];
    for (const target of targets) {
      target.dispatchEvent(new KeyboardEvent('keydown', options));
      target.dispatchEvent(new KeyboardEvent('keypress', options));
      target.dispatchEvent(new KeyboardEvent('keyup', options));
    }
  }

  async function pasteInto(pick, text) {
    const box = chatBoxFrom(pick);
    if (!box) {
      return { error: 'Chat box not found. The page may have changed, so please pick the chat box again.' };
    }
    scrollIntoViewSafely(box);
    await sleep(80);
    try {
      if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
        box.focus();
        setNativeValue(box, text);
      } else if (box.isContentEditable) {
        await insertIntoEditable(box, text);
      } else {
        // A [role="textbox"] that forgot contenteditable, or an odd custom
        // element. Write the text and announce it, the same way the editable
        // fallback does, so scripts listening for input still react.
        box.focus();
        box.textContent = text;
        box.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertText', data: text
        }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (err) {
      return {
        error: 'I could not put the text into the chat box. ' +
          'Please pick the chat box again, clicking directly inside it.'
      };
    }
    await sleep(120);
    if (text.trim() && !boxText(box).trim()) {
      return {
        error: 'The chat box stayed empty after pasting. The spot may be wrong, so please pick the chat box again.'
      };
    }
    return { ok: true };
  }

  async function pressSend(pickSend, pickInput) {
    if (pickSend && pickSend.selector) {
      const button = sendButtonFrom(pickSend);
      if (!button) {
        return { error: 'Send button not found. The page may have changed, so please pick the send button again.' };
      }
      scrollIntoViewSafely(button);
      await sleep(60);
      if (!await waitUntilEnabled(button, ENABLE_WAIT_MS)) {
        const box = chatBoxFrom(pickInput);
        if (box) pressEnter(box);
        await sleep(400);
        return {
          error: 'The send button stayed disabled for 5 seconds, so I pressed Enter instead of clicking it. ' +
            'If nothing was sent, pick the send button again.'
        };
      }
      button.click();
      return { ok: true };
    }
    const box = chatBoxFrom(pickInput);
    if (!box) {
      return { error: 'Chat box not found. The page may have changed, so please pick the chat box again.' };
    }
    box.focus();
    pressEnter(box);
    return { ok: true };
  }

  // The whole paste-then-send step used by the loop.
  async function deliverMessage(picks, text) {
    const pasted = await pasteInto(picks.input, text);
    if (pasted.error) return pasted;
    await sleep(PASTE_WAIT_MS);
    return pressSend(picks.send, picks.input);
  }

  // ---------- the click-to-pick overlay ----------
  const PICKER_CSS = [
    '#cb-picker-box{position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;',
    'border:2px solid #2f6fed;background:rgba(47,111,237,.15);border-radius:4px;',
    'box-shadow:0 0 0 2px rgba(255,255,255,.65) inset;transition:all .05s linear}',
    '#cb-picker-label{position:fixed;z-index:2147483647;pointer-events:none;background:#1c2b4a;color:#fff;',
    'font:12px/1.3 Menlo,Consolas,monospace;padding:3px 7px;border-radius:5px;max-width:60vw;',
    'overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '#cb-picker-toast{position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);',
    'max-width:min(720px,94vw);background:#1c2b4a;color:#fff;padding:9px 14px;border-radius:9px;',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;',
    'box-shadow:0 6px 20px rgba(0,0,0,.28);pointer-events:none;text-align:center}',
    '#cb-picker-toast b{color:#ffd76a}'
  ].join('');

  function ensurePickerStyles() {
    if (document.getElementById('cb-picker-style')) return;
    const style = document.createElement('style');
    style.id = 'cb-picker-style';
    style.textContent = PICKER_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function elementUnderPoint(x, y) {
    let element = document.elementFromPoint(x, y);
    while (element && element.id && String(element.id).indexOf('cb-picker-') === 0) {
      element = element.parentElement;
    }
    return element;
  }

  async function startPicker(kind) {
    if (picking) stopPicker();
    const key = siteKey();
    ensurePickerStyles();

    const box = document.createElement('div');
    box.id = 'cb-picker-box';
    box.style.display = 'none';
    const label = document.createElement('div');
    label.id = 'cb-picker-label';
    label.style.display = 'none';
    const toast = document.createElement('div');
    toast.id = 'cb-picker-toast';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(label);
    document.documentElement.appendChild(toast);

    const state = {
      base: null,      // element under the mouse
      target: null,    // element that would be chosen (may be a parent)
      mouseX: 0,
      mouseY: 0,
      listeners: []
    };
    picking = state;

    const say = (html) => { toast.innerHTML = html; };
    say('Picking the <b>' + KIND_NAMES[kind] + '</b>. Hover, press <b>Arrow Up</b> for a bigger area, ' +
      '<b>Arrow Down</b> to go back, <b>click</b> to choose, <b>Esc</b> to cancel.');

    // Draw the blue box and the tag name of the current target.
    function paint() {
      const target = state.target;
      if (!target || !target.isConnected) {
        box.style.display = 'none';
        label.style.display = 'none';
        return;
      }
      const rect = target.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = Math.max(0, rect.width) + 'px';
      box.style.height = Math.max(0, rect.height) + 'px';
      label.style.display = 'block';
      label.textContent = Selectors.describeElement(target);
      label.style.top = (rect.top > 34 ? rect.top - 26 : rect.bottom + 4) + 'px';
      label.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 220)) + 'px';
    }

    function setBase(element) {
      state.base = element;
      state.target = element;
      paint();
    }

    // Mouse: highlight whatever is under the pointer.
    function onMouseMove(event) {
      state.mouseX = event.clientX;
      state.mouseY = event.clientY;
      const element = elementUnderPoint(event.clientX, event.clientY);
      if (element && element !== state.base) setBase(element);
    }

    // Keyboard: Arrow Up = parent, Arrow Down = one step back toward the mouse.
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        stopPicker();
        say('Picking cancelled. Nothing was saved.');
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        const parent = state.target && state.target.parentElement;
        if (parent && parent !== document.documentElement) {
          state.target = parent;
          paint();
        }
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (state.target && state.base && state.target !== state.base) {
          let child = state.base;
          while (child.parentElement && child.parentElement !== state.target) child = child.parentElement;
          state.target = child.parentElement === state.target ? child : state.base;
          paint();
        }
        return;
      }
      // Every other key belongs to the picker, not to the page.
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    // Click: save the target and leave pick mode.
    async function onClick(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!state.target) return;
      const rect = state.target.getBoundingClientRect();
      const point = {
        x: Math.round(state.mouseX || rect.left + rect.width / 2),
        y: Math.round(state.mouseY || rect.top + rect.height / 2)
      };
      for (const [type, handler] of state.listeners) window.removeEventListener(type, handler, true);
      state.listeners = [];
      await savePick(key, kind, state.target, point, say);
    }

    // Anything else the page could react to is swallowed in the capture phase.
    const swallow = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const add = (type, handler) => {
      window.addEventListener(type, handler, true);
      state.listeners.push([type, handler]);
    };
    add('mousemove', onMouseMove);
    add('keydown', onKeyDown);
    add('click', onClick);
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu', 'wheel']) {
      add(type, type === 'wheel' ? () => {} : swallow);
    }

    // Start with the element under the mouse, or the middle of the page.
    const first = elementUnderPoint(state.mouseX || window.innerWidth / 2, state.mouseY || window.innerHeight / 2);
    if (first) setBase(first);
  }

  // Build and save the selector for the element the user clicked.
  async function savePick(key, kind, clicked, point, say) {
    let element = clicked;

    // Chat box and send button: use the nearest real control.
    if (kind === 'input') {
      element = clicked.closest('textarea, input, [contenteditable="true"], [role="textbox"]') || clicked;
    } else if (kind === 'send') {
      element = clicked.closest('button, [role="button"], a') || clicked;
    }

    const result = Selectors.buildSelector(element, kind, document);
    if (result.error) {
      // Stay in pick mode so the user can try another spot.
      say('<b>I could not save that spot.</b> ' + result.error + ' Press Esc to cancel.');
      await startPickerFresh(kind);
      return;
    }

    const name = PICK_KEY_PREFIX + key;
    const stored = (await chrome.storage.local.get(name))[name] || {};
    stored[kind] = {
      selector: result.selector,
      count: result.count,
      kind: kind,
      pickedAt: Date.now(),
      x: point.x,
      y: point.y
    };
    await chrome.storage.local.set({ [name]: stored });

    let note = '';
    if (kind === 'reply') {
      note = result.count === 1
        ? ' It matches 1 reply now; new replies will be found automatically.'
        : ' It matches ' + result.count + ' replies and the last one is always the newest.';
      note += ' If that is wrong, pick it again and press Arrow Up before clicking.';
    } else if (result.fallback) {
      note = ' I used a long structural selector because no stable attributes were found; ' +
        'it may need refreshing after the site is redesigned.';
    } else if (result.exact === false) {
      note = ' Warning: this spot does not match exactly one element, so it is less reliable.';
    }
    say('<b>Saved the ' + KIND_NAMES[kind] + ' (' + result.count +
      (result.count === 1 ? ' match' : ' matches') + ').</b>' + note + ' Picking is finished.');
    await sleep(1800);
    stopPicker();
  }

  // Restart pick mode without stacking overlays (used when saving failed).
  // picking is already null here (onClick cleared it), so stopPicker only
  // removes the leftover overlay elements.
  function startPickerFresh(kind) {
    stopPicker();
    startPicker(kind).catch(() => {});
  }

  // Remove the overlay immediately. A delayed removal would be dangerous:
  // starting the picker again creates elements with the same ids, and the
  // old timer would then delete the new ones.
  function removeOverlay() {
    for (const id of ['cb-picker-box', 'cb-picker-label', 'cb-picker-toast']) {
      const element = document.getElementById(id);
      if (element) element.remove();
    }
  }

  function stopPicker() {
    if (!picking) {
      removeOverlay();
      return;
    }
    for (const [type, handler] of picking.listeners) window.removeEventListener(type, handler, true);
    picking = null;
    removeOverlay();
  }

  // ---------- messages from the popup and the background worker ----------
  const handlers = {
    // Popup: start click-to-pick mode. The popup closes right after this.
    async startPick(message) {
      await startPicker(message.kind);
      return { ok: true };
    },

    // Popup: read the newest reply with a copy mode, for "Test copy".
    async testCopy(message) {
      const pick = await readPicks(message.key || siteKey());
      if (!pick || !pick.reply) {
        return { error: 'The AI reply is not picked for this site yet. Press "Pick AI reply" first.' };
      }
      const reply = readLastReply(pick.reply.selector);
      if (!reply.ok) return { error: reply.error };
      const settings = message.settings || { mode: 'full' };
      const chosen = Extract.applyModeToText(reply.text, settings.mode, {
        start: settings.start,
        end: settings.end
      });
      const base = { ok: true, count: reply.count, full: reply.text };
      if (chosen.error) return Object.assign(base, { error: chosen.error });
      return Object.assign(base, { text: chosen.text, length: chosen.text.length });
    },

    // Popup: paste "test" into the chat box, without sending.
    async testPaste(message) {
      const pick = await readPicks(message.key || siteKey());
      if (!pick || !pick.input) {
        return { error: 'The chat box is not picked for this site yet. Press "Pick chat box" first.' };
      }
      const result = await pasteInto(pick.input, message.text || 'test');
      if (result.error) return result;
      return { ok: true, note: 'Done: "test" is in the chat box. It was NOT sent. Clear it before you start a run.' };
    },

    // Background worker: paste a message and press send.
    async deliver(message) {
      const picks = message.picks || await readPicks(siteKey());
      if (!picks || !picks.input) {
        return { error: 'Chat box not found: please pick the chat box on this site first.' };
      }
      return deliverMessage(picks, message.text);
    },

    // Background worker (once per second): the newest reply and match count.
    async readReply(message) {
      const picks = message.picks || await readPicks(siteKey());
      if (!picks || !picks.reply) {
        return { ok: false, error: 'The AI reply is not picked for this site yet. Please pick the AI reply.' };
      }
      return readLastReply(picks.reply.selector);
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = message && handlers[message.type];
    if (!handler) return false;
    // Answer within 20 seconds so the background worker never hangs.
    const timeout = sleep(20000).then(() => ({
      error: 'The page took too long to answer. Please reload the tab and try again.'
    }));
    const work = Promise.resolve()
      .then(() => handler(message))
      .catch((err) => ({ error: 'Something went wrong on the page: ' + plainPageError(err) }));
    Promise.race([work, timeout]).then((reply) => {
      try {
        sendResponse(reply);
      } catch (err) {
        // The other end went away; nothing left to do.
      }
    });
    return true; // keep the message channel open for the async answer
  });

  function plainPageError(err) {
    const text = err && err.message ? String(err.message) : String(err || 'unknown problem');
    if (/Extension context invalidated/i.test(text)) {
      return 'the extension was reloaded. Please refresh this page (F5) and try again.';
    }
    return text;
  }
})();
