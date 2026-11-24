// dev/fake-chrome.js
// A small fake of the parts of the Chrome extension API that Chat Bridge uses.
// It lets the whole extension run inside one Node process for testing.
'use strict';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFakeChrome(options) {
  const opts = options || {};
  const store = clone(opts.store || {});
  const listeners = new Map(); // event name -> [fn]
  const tabs = new Map();      // tabId -> { id, url, title, page }
  let nextTabId = 100;
  const scriptCalls = [];

  function emit(name, ...args) {
    for (const fn of listeners.get(name) || []) fn(...args);
  }

  function fireStorageChanged(changes, area) {
    emit('storage.onChanged', changes, area);
  }

  const local = {
    async get(keys) {
      const result = {};
      if (keys === null || keys === undefined) {
        Object.assign(result, clone(store));
      } else if (typeof keys === 'string') {
        if (keys in store) result[keys] = clone(store[keys]);
      } else if (Array.isArray(keys)) {
        for (const key of keys) if (key in store) result[key] = clone(store[key]);
      } else if (typeof keys === 'object') {
        for (const [key, fallback] of Object.entries(keys)) {
          result[key] = key in store ? clone(store[key]) : clone(fallback);
        }
      }
      // Storage in Chrome is snapshotted when the call is made.
      await new Promise((r) => setImmediate(r));
      return result;
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: clone(store[key]), newValue: clone(value) };
        store[key] = clone(value);
      }
      await new Promise((r) => setImmediate(r));
      if (opts.onChanged !== false) fireStorageChanged(changes, 'local');
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (!(key in store)) continue;
        changes[key] = { oldValue: clone(store[key]) };
        delete store[key];
      }
      await new Promise((r) => setImmediate(r));
      if (opts.onChanged !== false) fireStorageChanged(changes, 'local');
    },
    async clear() {
      for (const key of Object.keys(store)) delete store[key];
      await new Promise((r) => setImmediate(r));
    }
  };

  // Registers a fake tab whose "content script" is the object given.
  function registerTab(page, info) {
    const id = nextTabId++;
    tabs.set(id, Object.assign({ id, url: 'https://arena.ai/c/test', title: 'Fake chat ' + id }, info || {}, { page }));
    return id;
  }

  const chrome = {
    __store: store,
    __tabs: tabs,
    __scriptCalls: scriptCalls,
    __on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    __listeners: (name) => listeners.get(name) || [],
    __fire: emit,
    __registerTab: registerTab,
    __setTabPage: (id, page) => {
      const tab = tabs.get(id);
      tab.page = page;
    },
    __getTab: (id) => tabs.get(id),
    storage: { local, onChanged: { addListener: (fn) => chrome.__on('storage.onChanged', fn) } },
    runtime: {
      onMessage: { addListener: (fn) => chrome.__on('runtime.onMessage', fn) },
      onInstalled: { addListener: (fn) => chrome.__on('runtime.onInstalled', fn) },
      async getPlatformInfo() {
        if (opts.onHeartbeat) opts.onHeartbeat();
        return { os: 'linux', arch: 'x86-64' };
      },
      lastError: undefined
    },
    tabs: {
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('No tab with id: ' + tabId);
        return { id: tab.id, url: tab.url, title: tab.title };
      },
      async query() {
        const first = [...tabs.values()][0];
        return first ? [{ id: first.id, url: first.url, title: first.title }] : [];
      },
      sendMessage(tabId, message, callback) {
        const tab = tabs.get(tabId);
        const reply = (value) => {
          if (callback) setImmediate(() => callback(value));
        };
        if (!tab || !tab.page) {
          chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
          setImmediate(() => {
            if (callback) callback(undefined);
            chrome.runtime.lastError = undefined;
          });
          return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        }
        const promise = Promise.resolve()
          .then(() => tab.page.__handle(message))
          .then((value) => {
            reply(value);
            return value;
          });
        return promise;
      }
    },
    scripting: {
      async executeScript(details) {
        scriptCalls.push(details);
        const tab = tabs.get(details.target.tabId);
        if (!tab) throw new Error('No tab with id: ' + details.target.tabId);
        if (tab.page && typeof tab.page.__inject === 'function') tab.page.__inject();
        return [{ result: true }];
      }
    }
  };
  return chrome;
}

module.exports = { createFakeChrome };
