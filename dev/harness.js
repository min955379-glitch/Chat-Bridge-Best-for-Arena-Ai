// dev/harness.js
// Loads background.js (the real service worker code) inside Node, wired to
// fake tabs and a fake chrome API. The whole loop then runs for real:
// polling, waiting for silence, copy modes, stop, timeout, API fallback.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFakeChrome } = require('./fake-chrome.js');

const EXTENSION_DIR = path.join(__dirname, '..', 'extension');

// Build one isolated copy of the extension's background worker.
function createWorker(options) {
  const opts = options || {};
  const chrome = createFakeChrome(opts);
  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    Promise,
    JSON,
    URL,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    AbortController,
    fetch: opts.fetch
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  // Read the reply more often in tests so the suite finishes quickly.
  // Production always uses the 1 second interval required by the brief.
  if (opts.pollMs) sandbox.__chatBridgePollMs = opts.pollMs;
  vm.createContext(sandbox);

  // importScripts used by background.js: run each file in the same context.
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      const code = fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8');
      vm.runInContext(code, sandbox, { filename: file });
    }
  };

  const background = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');
  vm.runInContext(background, sandbox, { filename: 'background.js' });

  // Grab the message listener the worker registered.
  const messageListeners = chrome.__listeners('runtime.onMessage');

  return {
    chrome,
    sandbox,
    // Send a message to the worker exactly like the popup does.
    send(message) {
      return new Promise((resolve, reject) => {
        let answered = false;
        const sendResponse = (reply) => {
          if (answered) return;
          answered = true;
          resolve(reply);
        };
        try {
          for (const listener of messageListeners) listener(message, {}, sendResponse);
        } catch (err) {
          reject(err);
        }
        setTimeout(() => {
          if (!answered) reject(new Error('The worker never answered ' + message.type));
        }, 120000);
      });
    },
    // Wait until the status line says something specific.
    waitForStatus(match, timeoutMs) {
      return new Promise((resolve, reject) => {
        const limit = Date.now() + (timeoutMs || 10000);
        const check = async () => {
          const status = chrome.__store.status || {};
          if (typeof match === 'string' ? String(status.text || '').includes(match) : match(status)) {
            resolve(status);
            return;
          }
          if (Date.now() > limit) {
            reject(new Error('Status never matched. Last status: ' + JSON.stringify(chrome.__store.status)));
            return;
          }
          setTimeout(check, 10);
        };
        check();
      });
    },
    // Wait until the run has really finished (status.running turns false).
    waitForIdle(timeoutMs) {
      return new Promise((resolve, reject) => {
        const limit = Date.now() + (timeoutMs || 20000);
        const check = () => {
          const status = chrome.__store.status || {};
          if (status.running === false) {
            resolve(status);
            return;
          }
          if (Date.now() > limit) {
            reject(new Error('Worker never became idle. Last status: ' + JSON.stringify(status)));
            return;
          }
          setTimeout(check, 25);
        };
        check();
      });
    },
    status: () => chrome.__store.status,
    log: () => chrome.__store.log || []
  };
}

module.exports = { createWorker, EXTENSION_DIR };
