// dev/fake-dom.js
// The tests use jsdom, which is a real DOM implementation, so the selector
// tests behave exactly like a browser. jsdom is only needed for the tests;
// the extension itself has no dependencies.
// Install once with:  npm install
'use strict';

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (err) {
  throw new Error('The tests need jsdom. Run "npm install" in the project folder first.');
}

// Build a page from a tiny template language:
//   h('div', { class: 'x' }, h('p', {}, 'text'))
// Nested h() calls are marked so their HTML is not escaped a second time.
const RAW = '\u0000raw\u0000';

function h(tag, attrs, ...children) {
  const attributes = Object.entries(attrs || {})
    .map(([name, value]) => ' ' + name + '="' + String(value).replace(/"/g, '&quot;') + '"')
    .join('');
  const inner = children.flat(Infinity)
    .filter((c) => c !== null && c !== undefined)
    .map((child) => {
      if (typeof child !== 'string') return child;
      return child.startsWith(RAW) ? child.slice(RAW.length) : escapeHtml(child);
    })
    .join('');
  return RAW + '<' + tag + attributes + '>' + inner + '</' + tag + '>';
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripRaw(markup) {
  return String(markup).split(RAW).join('');
}

// jsdom does not implement innerText, which real pages always have and which
// Chat Bridge uses to read replies (it follows visible line breaks).
// This polyfill is close to the browser behaviour for simple content.
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'HR', 'FIGURE', 'FIGCAPTION']);

function installInnerText(win) {
  // jsdom has no innerText. This helper produces the text a browser would
  // roughly show: block elements start on a new line, <br> breaks a line,
  // and text inside <pre> keeps its own spaces and line breaks.
  // It is only used by the tests; real pages have innerText built in.
  function isPreformatted(node) {
    for (let current = node; current && current.nodeType === 1; current = current.parentNode) {
      if (current.tagName === 'PRE') return true;
    }
    return false;
  }

  function walk(node, out) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.nodeValue;
        out.text += isPreformatted(node) ? text : text.replace(/[ \t\n\r]+/g, ' ');
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toUpperCase();
      if (child.hasAttribute('hidden') || child.getAttribute('aria-hidden') === 'true') continue;
      if (tag === 'BR') { out.text += '\n'; continue; }
      if (tag === 'PRE') {
        out.text += '\n' + child.textContent.replace(/^\n+|\n+$/g, '') + '\n';
        continue;
      }
      if (BLOCK_TAGS.has(tag)) {
        out.text += '\n';
        walk(child, out);
        out.text += '\n';
        continue;
      }
      walk(child, out);
    }
  }

  Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
    get() {
      if (this.tagName === 'PRE') return this.textContent.replace(/^\n+|\n+$/g, '');
      const out = { text: '' };
      walk(this, out);
      // Blocks add a newline on both sides, so squash double line breaks
      // (but never touch the text inside <pre>, which was added as-is).
      return out.text
        .split('\n')
        .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ''))
        .join('\n')
        .replace(/\n{2,}/g, '\n')
        .replace(/^\n+|\n+$/g, '');
    },
    set(value) { this.textContent = value; },
    configurable: true
  });
}

// Return a document whose body is the given markup.
function makeDoc(bodyMarkup) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body>' + stripRaw(bodyMarkup) + '</body></html>',
    { pretendToBeVisual: true });
  installInnerText(dom.window);
  return dom.window.document;
}

// A full page (with a window, so events, getSelection and elementFromPoint work).
function makePage(html, url) {
  // runScripts: 'outside-only' gives the window a real eval(), which the
  // content-script tests use to load extension files into the page.
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body>' + stripRaw(html) + '</body></html>',
    { pretendToBeVisual: true, runScripts: 'outside-only', url: url || 'https://arena.ai/c/1234' });
  installInnerText(dom.window);
  return { window: dom.window, document: dom.window.document };
}

module.exports = { h, makeDoc, makePage, escapeHtml, installInnerText };
