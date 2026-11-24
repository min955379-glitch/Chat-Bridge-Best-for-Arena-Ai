// selectors.js — builds CSS selectors for the three spots the user picks
// by clicking:
//   * chat box   -> must match exactly one element (the clicked one)
//   * send button-> must match exactly one element (the clicked one)
//   * AI reply   -> must match every AI reply, so future replies are found too
// It avoids random-looking classes such as "css-1x2y3z" or "sc-kfzBvf".
// Plain JavaScript, no dependencies. Used by content.js and by Node tests.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatBridgeSelectors = api;
})(typeof self !== 'undefined' ? self : null, function () {
  'use strict';

  // Attributes that websites keep stable across deploys.
  const STABLE_ATTRS = [
    'data-testid', 'data-test-id', 'data-test', 'data-role', 'data-message-author-role',
    'data-author', 'data-component', 'data-element-id', 'name', 'placeholder',
    'aria-label', 'title', 'role'
  ];
  const MAX_COLLECT = 400;          // stop counting after this many matches
  const MAX_REPLY_MATCHES = 200;    // a reply selector must not be more generic than this

  function escapeCss(value) {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(String(value));
    return String(value).replace(/([^a-zA-Z0-9_\u00a0-\uffff-])/g, '\\$1');
  }

  function escapeAttr(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Is a class name safe to put in a selector? We reject hash-like names.
  function isStableClass(name) {
    if (typeof name !== 'string' || !name) return false;
    if (name.length > 40) return false;
    if (!/^[A-Za-z][\w-]*$/.test(name)) return false;      // no "p1v2x3" hashes
    if (name.length >= 5 && /\d/.test(name)) return false; // no "css-1x2y3z"
    // "sc-kfzBvf" is a styled-components hash: letters only, but the last
    // part mixes capitals inside a word.
    const tail = name.split('-').pop();
    if (/[a-z][A-Z]/.test(tail)) return false;
    return true;
  }

  // Is this id safe to use? Very few ids are unique enough to keep.
  function isStableId(id) {
    if (typeof id !== 'string' || !id) return false;
    if (id.length > 40) return false;
    if (!/^[A-Za-z][\w-]*$/.test(id)) return false;
    if (/\d{3,}/.test(id)) return false;                   // no "uid-123456"
    return true;
  }

  function tagOf(el) { return el && el.tagName ? el.tagName.toLowerCase() : ''; }

  // Some sites name the speaker in a child element instead of an attribute,
  // for example  <span class="role">Assistant</span> inside each message.
  // Count how many matches look like AI messages by their first words.
  function aiLabelRatio(matches) {
    if (!matches.length) return 0;
    let ai = 0;
    for (const node of matches) {
      const start = String(node.innerText || node.textContent || '').trim().slice(0, 24).toLowerCase();
      if (/^(assistant|ai|grok|claude|gemini|chatgpt|model|bot)\b/.test(start)) ai += 1;
    }
    return ai / matches.length;
  }

  // Does this selector look like "the AI's messages"? Sites mark that with
  // data-message-author-role, data-role, class names like "assistant" or
  // "ai", and similar. Selectors that match every message get 0.
  function aiHintScore(selector) {
    const text = String(selector);
    if (/author-role="assistant"|data-role="assistant"|\bassistant\b|\bai\b/i.test(text)) return 2;
    if (/\bmessage\b|\breply\b|\banswer\b|\bchat-message\b/i.test(text)) return 1;
    return 0;
  }

  // How much text the matches hold on average. A real reply is a whole
  // message, so it holds more text than one paragraph or a span.
  function replyWeight(matches, doc) {
    let total = 0;
    for (const node of matches) {
      total += String(node.innerText || node.textContent || '').length;
    }
    const average = matches.length ? total / matches.length : 0;
    // A wrapper holding (nearly) the whole conversation is not a reply.
    const wholePage = doc.body ? String(doc.body.textContent || '').length : 0;
    if (wholePage && average > wholePage * 0.75) return 0;
    return average;
  }

  // How many AI replies does the page seem to have? Only trustworthy signals
  // are used (an explicit AI role marker or repeated article blocks), because
  // "main p" would also count paragraphs inside one reply.
  function countPossibleReplies(doc) {
    for (const sel of [
      '[data-message-author-role="assistant"]', '[data-role="assistant"]',
      '[data-author="assistant"]', '[data-message-author-role]'
    ]) {
      const found = queryAll(doc, sel);
      if (found.length) return found.length;
    }
    const articles = queryAll(doc, 'article');
    if (articles.length >= 2) return articles.length;
    return 0;
  }

  // Is the clicked element inside one of the matches (or the match itself)?
  function containsClick(matches, el) {
    for (const node of matches) {
      if (node === el) return true;
      if (typeof node.contains === 'function' && node.contains(el)) return true;
    }
    return false;
  }

  // Query with a cap so a huge selector cannot freeze the page. Never throws.
  function queryAll(doc, selector, cap) {
    const limit = cap || MAX_COLLECT;
    const found = [];
    let nodes;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch (err) {
      return found;
    }
    for (let i = 0; i < nodes.length; i++) {
      if (found.length >= limit) break;
      found.push(nodes[i]);
    }
    return found;
  }

  // Build the list of candidate selectors, closest to the element first.
  function collectCandidates(el, kind, doc) {
    const candidates = [];
    const seen = new Set();
    const add = (sel, level, attrBased) => {
      if (!sel || seen.has(sel)) return;
      seen.add(sel);
      candidates.push({ sel: sel, level: level, attrBased: Boolean(attrBased) });
    };
    const tag = tagOf(el);
    const ownClasses = Array.from(el.classList || []).filter(isStableClass);

    // 1. Stable attributes on the element itself, with and without the tag name.
    const attributeSelectors = (node) => {
      const out = [];
      for (const attr of STABLE_ATTRS) {
        if (!node.hasAttribute(attr)) continue;
        const value = node.getAttribute(attr);
        if (!value || value.length > 120) continue;
        out.push(tagOf(node) + '[' + attr + '="' + escapeAttr(value) + '"]');
        out.push('[' + attr + '="' + escapeAttr(value) + '"]');
      }
      return out;
    };

    // 2. Id, only when it looks stable. An id is unique by definition, so it
    //    is never used for the AI reply: that spot must match every reply.
    if (kind !== 'reply' && el.id && isStableId(el.id)) add('#' + escapeCss(el.id), 0, true);
    for (const sel of attributeSelectors(el)) add(sel, 0, true);

    // 3. Tag with stable classes, one class up to four classes.
    if (ownClasses.length) {
      for (const cls of ownClasses) add(tag + '.' + escapeCss(cls), 0, false);
      if (ownClasses.length > 1) {
        add(tag + '.' + ownClasses.slice(0, 2).map(escapeCss).join('.'), 0, false);
      }
      if (ownClasses.length > 2) {
        add(tag + '.' + ownClasses.slice(0, 3).map(escapeCss).join('.'), 0, false);
      }
      if (ownClasses.length > 3) {
        add(tag + '.' + ownClasses.slice(0, 4).map(escapeCss).join('.'), 0, false);
      }
    }

    // 4. Walk up the page. Each ancestor can be an anchor: the answer containers
    //    on most sites live one or two levels above the text the user clicks.
    let node = el.parentElement;
    for (let level = 1; node && level <= 6; level++, node = node.parentElement) {
      if (node === doc.body || node === doc.documentElement) break;
      const anchorTag = tagOf(node);
      const anchors = [];
      // Same reason as above: ids identify one message, not every reply.
      if (kind !== 'reply' && node.id && isStableId(node.id)) anchors.push('#' + escapeCss(node.id));
      for (const sel of attributeSelectors(node)) anchors.push(sel);
      const nodeClasses = Array.from(node.classList || []).filter(isStableClass);
      for (const cls of nodeClasses) anchors.push(anchorTag + '.' + escapeCss(cls));
      if (nodeClasses.length > 1) anchors.push(anchorTag + '.' + nodeClasses.slice(0, 2).map(escapeCss).join('.'));

      for (const anchor of anchors) {
        add(anchor, level, anchor.charAt(0) === '[' || anchor.charAt(0) === '#');
        // Anchor plus plain child tags: "article > div > p"
        const chain = childChain(node, el);
        if (!chain) continue;
        const inside = chain.join(' > ');
        add(anchor + ' > ' + inside, level, false);
        add(anchor + ' ' + inside, level * 2, false);
        // Data attribute plus a few child tags. An attribute selector on its
        // own refers to an attribute of the clicked element, so give it a
        // tag name first: "div[data-message-author-role=...] > p > span".
        if (anchor.charAt(0) === '[') add(anchorTag + anchor + ' > ' + inside, level, false);
      }
    }

    // 5. Tag-only candidates: useful for the reply when the page has no classes.
    add(tag, 9, false);

    return candidates;
  }

  // Plain tag names from the anchor down to the element, e.g. ["div", "p"].
  function childChain(anchor, el) {
    const chain = [];
    let node = el;
    while (node && node !== anchor) {
      chain.unshift(tagOf(node));
      node = node.parentElement;
    }
    if (node !== anchor || chain.length === 0) return null;
    return chain;
  }

  // The lowest level a candidate may have. Every candidate must contain the
  // clicked element (checked by "matches.includes(el)"), so a small element
  // around the click is never saved by accident. We simply allow all levels.
  function startLevel() {
    return 0;
  }

  // Full nth-of-type path, the last resort for the chat box and send button.
  function uniquePath(el, doc) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.body && node !== doc.documentElement) {
      const parent = node.parentElement;
      const tag = tagOf(node);
      if (!parent) break;
      const sameTag = Array.from(parent.children).filter((child) => tagOf(child) === tag);
      if (sameTag.length > 1) {
        parts.unshift(tag + ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')');
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : '';
  }

  // Build the selector for a picked element.
  // Returns { selector, count, exact } or { error }.
  function buildSelector(el, kind, doc) {
    if (!el || el.nodeType !== 1) return { error: 'That is not an element I can use. Please click again.' };
    doc = doc || el.ownerDocument;
    const candidates = collectCandidates(el, kind, doc);
    const requireExact = kind !== 'reply';
    const from = startLevel();
    // If the page clearly has several messages, a reply selector that matches
    // only one of them is almost certainly pinned to a single message.
    const pageReplies = kind === 'reply' ? countPossibleReplies(doc) : 0;
    let best = null;

    for (const cand of candidates) {
      if (cand.level < from) continue;                      // too close to the text
      const matches = queryAll(doc, cand.sel);
      if (!matches.length) continue;
      if (!containsClick(matches, el)) continue;            // must contain the clicked spot
      const count = matches.length;
      if (requireExact) {
        if (count === 1) { best = { sel: cand.sel, count: 1, exact: true }; break; }
        continue;
      }
      if (count > MAX_REPLY_MATCHES) continue;              // too generic to be useful
      // A bare tag ("span", "p") would only read the text click, not the reply.
      if (cand.level >= 9) continue;
      // The reply selector must match ONE WHOLE ANSWER per reply:
      //   * fewer matches than the page has replies -> it wraps everything
      //   * a very small element (only part of an answer) holds little text,
      //     so "how much text does each match hold" is the best tie breaker.
      const tooBig = pageReplies >= 2 && count < pageReplies;
      const weight = replyWeight(matches, doc);
      const score = {
        tooBig: tooBig ? 1 : 0,
        // A selector that names the AI (role/author attributes) is much more
        // reliable than one that also matches the user's own messages.
        aiHints: aiHintScore(cand.sel),
        // Second best signal: most matches start with "Assistant"/"AI"/...
        aiLabel: Math.round(aiLabelRatio(matches) * 10),
        weight: weight,
        count: count,
        length: cand.sel.length
      };
      // Compare in this order: not too big, names the AI, most matches look
      // like AI messages, holds more text, fewer matches, shorter selector.
      const keys = ['tooBig', 'aiHints', 'aiLabel', 'weight', 'count', 'length'];
      const preferSmaller = { tooBig: true, aiHints: false, aiLabel: false,
        weight: false, count: true, length: true };
      const better = !best || (function compare() {
        for (const key of keys) {
          if (score[key] === best.score[key]) continue;
          return preferSmaller[key] ? score[key] < best.score[key] : score[key] > best.score[key];
        }
        return false;
      })();
      if (better) best = { sel: cand.sel, count: count, exact: false, score: score };
    }

    if (best) return { selector: best.sel, count: best.count, exact: best.exact };

    // Nothing tidy was found.
    if (requireExact) {
      const path = uniquePath(el, doc);
      if (path) return { selector: path, count: 1, exact: false, fallback: true };
      return { error: 'I could not make a stable selector for that spot. Please click directly on it (try Arrow Up for a bigger area).' };
    }
    // Nothing tidy was found. Try a structural selector on the parent chain
    // that still matches more than one block (the replies are usually
    // siblings with identical structure).
    const structural = structuralReplySelector(el, doc);
    if (structural) return structural;
    return {
      error: 'I could not find a selector that matches every reply. Please click on the reply text, ' +
        'or press Arrow Up once or twice to select a bigger area around it.'
    };
  }

  // A path from <body> down to a node, using plain tags. The node itself is
  // written without a position, so all its siblings with the same tag match.
  function repeatingPath(node, doc) {
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && current !== doc.body && current !== doc.documentElement) {
      const parent = current.parentElement;
      if (!parent) return '';
      const tag = tagOf(current);
      const sameTag = Array.from(parent.children).filter((child) => tagOf(child) === tag);
      // The repeating node is matched without a position; the ancestors are
      // matched with one so the path stays unique above it.
      if (current !== node && sameTag.length > 1) {
        parts.unshift(tag + ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')');
      } else {
        parts.unshift(tag);
      }
      current = parent;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : '';
  }

  // A last-resort reply selector: the closest ancestor whose tag repeats under
  // its own parent, for example "div > div > div". It ignores class names, so
  // it keeps working when the site changes them, and it matches every block
  // with the same shape, which includes future replies.
  function structuralReplySelector(el, doc) {
    let node = el;
    for (let level = 0; node && level < 6; level++, node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent || parent === doc.body) break;
      const tag = tagOf(node);
      const siblings = Array.from(parent.children).filter((child) => tagOf(child) === tag);
      if (siblings.length < 2) continue;
      // Build a path WITHOUT the position of this node, so every block of the
      // same shape matches: "body > div > div > div".
      const path = repeatingPath(node, doc);
      if (!path) continue;
      const matches = queryAll(doc, path);
      if (matches.length < 2) continue;
      // The clicked element must be inside the saved match.
      if (!containsClick(matches, el)) continue;
      const weight = replyWeight(matches, doc);
      if (!weight) continue;
      return { selector: path, count: matches.length, exact: false, fallback: true };
    }
    return null;
  }

  // Short description of an element, shown in the picker toast.
  function describeElement(el) {
    if (!el) return '';
    const tag = tagOf(el);
    const id = el.id ? '#' + el.id : '';
    const cls = Array.from(el.classList || []).slice(0, 2).map((c) => '.' + c).join('');
    return '<' + tag + id + cls + '>';
  }

  // Share of matches that look like AI messages (used for a friendly warning).
  function aiShareOf(selector, doc) {
    const matches = queryAll(doc || document, selector, 50);
    return aiLabelRatio(matches);
  }

  return {
    MAX_REPLY_MATCHES,
    aiShareOf,
    buildSelector,
    describeElement,
    escapeAttr,
    escapeCss,
    isStableClass,
    isStableId,
    queryAll,
    startLevel,
    uniquePath
  };
});
