// dev/smoke.js
// A quick check that the extension folder is complete and loadable.
// Run with:  node dev/smoke.js
// It checks the manifest, that every referenced file exists, that every
// JavaScript file parses, and that each helper exposes what the next file needs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension');
const problems = [];
const notes = [];

function must(condition, message) {
  if (!condition) problems.push(message);
}

// 1. manifest
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
} catch (err) {
  console.error('manifest.json is not valid JSON:', err.message);
  process.exit(1);
}
must(manifest.manifest_version === 3, 'manifest_version must be 3');
must(manifest.background && manifest.background.service_worker, 'a service worker is declared');
for (const permission of ['storage', 'scripting', 'tabs']) {
  must((manifest.permissions || []).includes(permission), 'missing permission: ' + permission);
}
for (const host of ['<all_urls>', 'https://generativelanguage.googleapis.com/*', 'https://api.x.ai/*']) {
  must((manifest.host_permissions || []).includes(host), 'missing host permission: ' + host);
}
notes.push('manifest.json: MV3, ' + manifest.permissions.join(', ') + ', ' +
  manifest.host_permissions.length + ' host permissions');

// 2. every referenced file exists
const referenced = new Set([
  manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
  ...Object.values((manifest.icons) || {})
]);
for (const file of referenced) {
  must(file && fs.existsSync(path.join(EXT, file)), 'file listed in the manifest is missing: ' + file);
}
notes.push(referenced.size + ' manifest-listed files exist');

// 3. popup.html refers only to real files
const popupHtml = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
for (const match of popupHtml.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  const target = match[1];
  if (/^https?:/.test(target)) continue;
  must(fs.existsSync(path.join(EXT, target)), 'popup.html points to a missing file: ' + target);
}

// 4. every JavaScript file parses
const jsFiles = fs.readdirSync(EXT).filter((f) => f.endsWith('.js'));
for (const file of jsFiles) {
  const code = fs.readFileSync(path.join(EXT, file), 'utf8');
  try {
    new vm.Script(code, { filename: file });
  } catch (err) {
    problems.push(file + ' has a syntax error: ' + err.message);
  }
}
notes.push(jsFiles.length + ' JavaScript files parse cleanly');

// 5. the service worker can import its helpers and they expose their APIs
const sandbox = { self: null, console, setTimeout, clearTimeout, Date, JSON, Math, Promise, URL, Error,
  Object, Array, String, Number, Boolean, Map, Set, chrome: { runtime: { onMessage: { addListener() {} },
    onInstalled: { addListener() {} }, getPlatformInfo: async () => ({}) },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} } },
  tabs: { get: async () => ({}), sendMessage: async () => ({}), query: async () => [],
    create: async () => ({}) }, scripting: { executeScript: async () => [] } } };
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
sandbox.importScripts = (...files) => {
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox, { filename: file });
};
try {
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  must(typeof sandbox.ChatBridgeCommon.siteKeyFor === 'function', 'common.js did not load in the worker');
  must(typeof sandbox.ChatBridgeExtract.betweenMarkers === 'function', 'extract.js did not load in the worker');
  must(typeof sandbox.ChatBridgeApi.requestWithFallback === 'function', 'api-client.js did not load in the worker');
  notes.push('background.js loads its three helper files and starts');
} catch (err) {
  problems.push('background.js failed to load: ' + err.message);
}

// 6. the content script's helpers load in a page-like context.
// A browser page has window === self, which is how the helpers find their host.
const pageSandbox = { window: {}, console, document: {}, setTimeout, Date, JSON, Math, Promise, URL };
pageSandbox.window = pageSandbox;
pageSandbox.self = pageSandbox;
vm.createContext(pageSandbox);
for (const file of ['selectors.js', 'extract.js', 'common.js']) {
  vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), pageSandbox, { filename: file });
}
must(typeof pageSandbox.ChatBridgeSelectors.buildSelector === 'function', 'selectors.js API missing');
must(typeof pageSandbox.ChatBridgeExtract.applyModeToElement === 'function', 'extract.js API missing');
must(typeof pageSandbox.ChatBridgeCommon.normalizeSettings === 'function', 'common.js API missing');
notes.push('page helpers load and expose their APIs');

// 7. no API keys are hard-coded anywhere
for (const file of fs.readdirSync(EXT)) {
  if (!/\.(js|html|json|css)$/.test(file)) continue;
  const text = fs.readFileSync(path.join(EXT, file), 'utf8');
  const looksLikeKey = /(?:AIza[0-9A-Za-z_-]{30,}|xai-[0-9A-Za-z]{20,}|sk-[0-9A-Za-z]{20,})/.exec(text);
  must(!looksLikeKey, file + ' seems to contain a hard-coded API key');
}
notes.push('no hard-coded API keys found');

// 8. the icons are real PNG files
for (const size of [16, 48, 128]) {
  const file = path.join(EXT, 'icons', 'icon' + size + '.png');
  const header = fs.existsSync(file) ? fs.readFileSync(file).subarray(0, 8) : null;
  must(header && header.toString('hex') === '89504e470d0a1a0a', 'icons/icon' + size + '.png is missing or not a PNG');
}
notes.push('three PNG icons are valid');

// Report
console.log('Chat Bridge — smoke check\n');
for (const note of notes) console.log('  ok   ' + note);
if (problems.length) {
  console.log('');
  for (const problem of problems) console.log('  FAIL ' + problem);
  console.log('\n' + problems.length + ' problem(s) found.');
  process.exit(1);
}
console.log('\nEverything looks good. Load the "extension" folder in chrome://extensions.');
