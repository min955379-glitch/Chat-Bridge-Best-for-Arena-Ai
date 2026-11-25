// popup.js — the popup window. It shows the picks, the settings and the run
// controls.
// All the real work happens in background.js and content.js.
// Plain JavaScript. No frameworks.

const Common = window.ChatBridgeCommon;
const Extract = window.ChatBridgeExtract;

const $ = (id) => document.getElementById(id);
const el = {
  modeBadge: $('mode-badge'),
  siteLabel: $('site-label'),
  tickInput: $('tick-input'),
  tickSend: $('tick-send'),
  tickReply: $('tick-reply'),
  pickInput: $('pick-input'),
  pickSend: $('pick-send'),
  pickReply: $('pick-reply'),
  testCopy: $('test-copy'),
  testPaste: $('test-paste'),
  clearPicks: $('clear-picks'),
  makeA: $('make-a'),
  makeB: $('make-b'),
  rolesLine: $('roles-line'),
  testOutput: $('test-output'),
  testTitle: $('test-title'),
  testText: $('test-text'),
  testClose: $('test-close'),
  rounds: $('rounds'),
  silence: $('silence'),
  copyModeA: $('copy-mode-a'),
  copyModeB: $('copy-mode-b'),
  markerStart: $('marker-start'),
  markerEnd: $('marker-end'),
  timeout: $('timeout'),
  maxRounds: $('max-rounds'),
  prefix: $('prefix'),
  suffix: $('suffix'),
  stopIfSame: $('stop-if-same'),
  stopWord: $('stop-word'),
  mode: $('mode'),
  apiSettings: $('api-settings'),
  provider: $('provider'),
  geminiKey: $('gemini-key'),
  geminiModel: $('gemini-model'),
  grokKey: $('grok-key'),
  grokModel: $('grok-model'),
  memory: $('memory'),
  systemPrompt: $('system-prompt'),
  helperOn: $('helper-on'),
  helperBody: $('helper-body'),
  helperRoles: $('helper-roles'),
  helperDetect: $('helper-detect'),
  helperDetectResult: $('helper-detect-result'),
  helperBest: $('helper-best'),
  helperStop: $('helper-stop'),
  goal: $('goal'),
  helperStopEvery: $('helper-stop-every'),
  helperMaxCalls: $('helper-max-calls'),
  start: $('start'),
  stop: $('stop'),
  status: $('status'),
  log: $('log'),
  copyLog: $('copy-log'),
  showReadme: $('show-readme')
};

let settings = Common.normalizeSettings({});
let state = { status: null, log: [], roles: { A: null, B: null }, run: null };
let currentTab = null;       // the tab the popup was opened on
let currentKey = '';         // site key of that tab
let currentPicks = null;     // picks saved for that site
let saveTimer = null;        // debounce for the settings fields
let busy = false;

// ---------- small helpers ----------
function tabMessage(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (reply) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(reply || { error: 'The page did not answer.' });
      });
    } catch (err) {
      resolve({ error: err && err.message ? err.message : 'The page did not answer.' });
    }
  });
}

function bgMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(reply || {});
    });
  });
}

// The content script may be missing on tabs opened before the extension was
// installed or reloaded. Add it, then try again.
async function tabMessageWithRetry(tabId, message) {
  const first = await tabMessage(tabId, message);
  if (!first || !first.error) return first;
  const missing = /Receiving end does not exist|Could not establish connection|message port closed/i.test(first.error);
  if (!missing) return first;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['selectors.js', 'extract.js', 'common.js', 'content.js']
    });
  } catch (err) {
    return { error: 'This page cannot be used by the extension. Open a normal website tab.' };
  }
  return await tabMessage(tabId, message);
}

function setTestOutput(title, text, isError) {
  el.testTitle.textContent = title;
  el.testText.textContent = text;
  el.testText.style.color = isError ? '#c0392b' : '';
  el.testOutput.hidden = false;
  // Bring the box into view, but never fail if the browser cannot scroll.
  if (typeof el.testOutput.scrollIntoView === 'function') {
    try { el.testOutput.scrollIntoView({ block: 'nearest' }); } catch (err) { /* not important */ }
  }
}

function showStatus(status) {
  const value = status || { text: 'Ready.', tone: 'idle', running: false };
  el.status.textContent = value.text || 'Ready.';
  el.status.className = 'status ' + (value.tone || 'idle');
  el.start.disabled = Boolean(value.running) || busy;
  el.stop.disabled = !value.running;
}

function renderLog(list) {
  el.log.textContent = '';
  const items = Array.isArray(list) ? list : [];
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing has happened yet.';
    el.log.appendChild(li);
    return;
  }
  for (const entry of items) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = Common.formatClock(entry.t);
    li.appendChild(time);
    li.appendChild(document.createTextNode(String(entry.text || '')));
    el.log.appendChild(li);
  }
  el.log.scrollTop = el.log.scrollHeight;
}

function renderPicks() {
  const picks = currentPicks || {};
  const fill = (tick, done, label) => {
    tick.textContent = done ? '✓' : '○';
    tick.className = 'tick' + (done ? ' done' : '');
    tick.title = done ? label + ' is picked' : label + ' is not picked';
  };
  fill(el.tickInput, Boolean(picks.input), 'Chat box');
  fill(el.tickSend, Boolean(picks.send), 'Send button');
  fill(el.tickReply, Boolean(picks.reply), 'AI reply');
}

function renderRoles() {
  const mine = currentTab ? currentTab.id : null;
  const isA = state.roles.A && state.roles.A === mine;
  const isB = state.roles.B && state.roles.B === mine;
  el.makeA.className = 'role' + (isA ? ' mine' : '');
  el.makeB.className = 'role' + (isB ? ' mine' : '');
  el.makeA.textContent = isA ? '✓ This is Tab A' : 'Make this Tab A';
  el.makeB.textContent = isB ? '✓ This is Tab B' : 'Make this Tab B';

  const parts = [];
  if (state.roles.A) parts.push('Tab A chosen');
  if (state.roles.B) parts.push('Tab B chosen');
  el.rolesLine.textContent = parts.length
    ? parts.join(' · ') + '. Open the other chat tab and choose the other role there.'
    : 'No tabs chosen yet. Choose Tab A here, then open the other chat and choose Tab B.';
}

function renderModeBadge() {
  el.modeBadge.textContent = settings.mode === 'api'
    ? 'Tab ↔ API (' + Common.providerLabel(settings.provider) + ')'
    : 'Tab ↔ Tab';
  el.apiSettings.hidden = settings.mode !== 'api';
}

// ---------- reading the current tab ----------
async function loadCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs && tabs[0] ? tabs[0] : null;
  if (!currentTab) {
    el.siteLabel.textContent = 'No tab found.';
    return;
  }
  if (!Common.isSupportedUrl(currentTab.url)) {
    el.siteLabel.textContent = 'This is a browser page, not a website. Open your chat tab first.';
    currentKey = '';
    currentPicks = null;
    renderPicks();
    return;
  }
  currentKey = Common.siteKeyFor(currentTab.url);
  el.siteLabel.textContent = Common.siteLabel(currentTab.url);
  const stored = await chrome.storage.local.get(Common.pickStorageKey(currentKey));
  currentPicks = stored[Common.pickStorageKey(currentKey)] || null;
  renderPicks();
}

// ---------- settings ----------
function readForm() {
  return Common.normalizeSettings({
    rounds: el.rounds.value,
    silence: el.silence.value,
    copyModeA: el.copyModeA.value,
    copyModeB: el.copyModeB.value,
    markerStart: el.markerStart.value,
    markerEnd: el.markerEnd.value,
    timeout: el.timeout.value,
    maxRounds: el.maxRounds.value,
    prefix: el.prefix.value,
    suffix: el.suffix.value,
    stopIfSame: el.stopIfSame.checked,
    stopWord: el.stopWord.value,
    mode: el.mode.value,
    provider: el.provider.value,
    geminiKey: el.geminiKey.value,
    geminiModel: el.geminiModel.value,
    grokKey: el.grokKey.value,
    grokModel: el.grokModel.value,
    memory: el.memory.value,
    systemPrompt: el.systemPrompt.value,
    helperOn: el.helperOn.checked,
    helperRoles: el.helperRoles.checked,
    helperBest: el.helperBest.checked,
    helperStop: el.helperStop.checked,
    goal: el.goal.value,
    helperStopEvery: el.helperStopEvery.value,
    helperMaxCalls: el.helperMaxCalls.value
  });
}

function fillForm(value) {
  el.rounds.value = value.rounds;
  el.silence.value = value.silence;
  el.copyModeA.value = value.copyModeA;
  el.copyModeB.value = value.copyModeB;
  el.markerStart.value = value.markerStart;
  el.markerEnd.value = value.markerEnd;
  el.timeout.value = value.timeout;
  el.maxRounds.value = value.maxRounds;
  el.prefix.value = value.prefix;
  el.suffix.value = value.suffix;
  el.stopIfSame.checked = value.stopIfSame;
  el.stopWord.value = value.stopWord;
  el.mode.value = value.mode;
  el.provider.value = value.provider;
  el.geminiKey.value = value.geminiKey;
  el.geminiModel.value = value.geminiModel;
  el.grokKey.value = value.grokKey;
  el.grokModel.value = value.grokModel;
  el.memory.value = value.memory;
  el.systemPrompt.value = value.systemPrompt;
  el.helperOn.checked = value.helperOn;
  el.helperRoles.checked = value.helperRoles;
  el.helperBest.checked = value.helperBest;
  el.helperStop.checked = value.helperStop;
  el.goal.value = value.goal;
  el.helperStopEvery.value = value.helperStopEvery;
  el.helperMaxCalls.value = value.helperMaxCalls;
  renderHelper();
  renderModeBadge();
}

// The helper options only appear when the master switch is on: a beginner
// should not have to wonder which of these boxes do anything.
function renderHelper() {
  const on = el.helperOn.checked;
  el.helperBody.hidden = !on;
  el.helperDetect.disabled = !on || !el.helperRoles.checked;
  el.goal.disabled = !on || !el.helperStop.checked;
  el.helperStopEvery.disabled = !on || !el.helperStop.checked;
}

// Save a moment after the user stops typing, so every keystroke is kept but
// the storage is not hammered.
function scheduleSave() {
  settings = readForm();
  renderModeBadge();
  renderHelper();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ settings: settings });
    renderModeBadge();
  }, 350);
}

async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await chrome.storage.local.set({ settings: settings });
}

// ---------- actions ----------
async function startPick(kind) {
  if (!currentTab || !currentKey) {
    setTestOutput('Cannot pick here', 'Open your chat tab first, then press the pick button.', true);
    return;
  }
  const reply = await tabMessageWithRetry(currentTab.id, { type: 'startPick', kind: kind });
  if (reply.error) {
    setTestOutput('Cannot pick here', reply.error, true);
    return;
  }
  // The page is now in pick mode, so close the popup to let the user click.
  window.close();
}

async function testCopy() {
  if (!currentTab || !currentKey) return setTestOutput('Test copy', 'Open your chat tab first.', true);
  if (!currentPicks || !currentPicks.reply) {
    return setTestOutput('Test copy', 'The AI reply is not picked for this site yet. Press "Pick AI reply" first.', true);
  }
  await flushSave();
  // Use the copy mode of the side this tab is. If it is neither A nor B, show
  // mode A so the user can still preview the picker.
  const mine = state.roles.A === currentTab.id ? 'A' : (state.roles.B === currentTab.id ? 'B' : 'A');
  const mode = mine === 'B' ? settings.copyModeB : settings.copyModeA;
  const reply = await tabMessageWithRetry(currentTab.id, {
    type: 'testCopy',
    key: currentKey,
    settings: {
      mode: mode,
      start: settings.markerStart,
      end: settings.markerEnd
    }
  });
  if (reply.error) {
    setTestOutput('Test copy', 'Something is wrong: ' + reply.error, true);
    return;
  }
  const modeName = Extract.MODE_LABELS[mode] || 'Full reply';
  const head = 'Copy mode ' + mine + ': ' + modeName + ' · ' + reply.length + ' characters · ' +
    (reply.count === 1 ? '1 reply matches' : reply.count + ' replies match') + '.';
  const preview = Extract.preview(reply.text, 200);
  setTestOutput('Test copy', head + '\n\n' + (preview || '(empty text)'), !reply.text);
}

async function testPaste() {
  if (!currentTab || !currentKey) return setTestOutput('Test paste', 'Open your chat tab first.', true);
  if (!currentPicks || !currentPicks.input) {
    return setTestOutput('Test paste', 'The chat box is not picked for this site yet. Press "Pick chat box" first.', true);
  }
  const reply = await tabMessageWithRetry(currentTab.id, { type: 'testPaste', key: currentKey, text: 'test' });
  if (reply.error) {
    setTestOutput('Test paste', 'Something is wrong: ' + reply.error, true);
    return;
  }
  setTestOutput('Test paste', reply.note || 'The word "test" is in the chat box. It was not sent.', false);
}

// Smart Helper part 1: ask the background worker which window is the brain.
// The worker changes the roles; this only shows the result in plain words.
async function detectRoles() {
  el.helperDetect.disabled = true;
  el.helperDetectResult.textContent = 'Thinking about both chats...';
  await flushSave();
  const reply = await bgMessage({ type: 'detectRoles' });
  el.helperDetect.disabled = false;
  renderHelper();
  if (reply && reply.error) {
    el.helperDetectResult.textContent = reply.error;
    el.helperDetectResult.className = 'hint detect-bad';
    return;
  }
  const message = (reply && reply.message) || 'The roles were set.';
  el.helperDetectResult.textContent = message;
  el.helperDetectResult.className = 'hint detect-good';
  // The worker saved the new roles; show them here too.
  const stored = await chrome.storage.local.get('roles');
  if (stored.roles) {
    state.roles = stored.roles;
    renderRoles();
  }
}

async function clearPicks() {
  if (!currentKey) return;
  await chrome.storage.local.remove(Common.pickStorageKey(currentKey));
  currentPicks = null;
  renderPicks();
  setTestOutput('Picks cleared', 'The three spots for ' + el.siteLabel.textContent + ' were removed. Pick them again.', false);
}

async function makeRole(role) {
  if (!currentTab) return;
  const other = role === 'A' ? 'B' : 'A';
  if (state.roles[other] === currentTab.id) {
    setTestOutput('Same tab', 'This tab is already Tab ' + other + '. Use two different tabs for a chat.', true);
    return;
  }
  // Remember a friendly title for the status line and the log.
  const titles = (await chrome.storage.local.get('roleTitles')).roleTitles || {};
  titles[currentTab.id] = currentTab.title || Common.siteLabel(currentTab.url || '');
  const roles = Object.assign({}, state.roles);
  roles[role] = currentTab.id;
  await chrome.storage.local.set({ roles: roles, roleTitles: titles });
  state.roles = roles;
  renderRoles();
}

// The worker answers "start" only when the whole run has finished, so the
// popup does not wait for it: the live status line shows the progress instead.
// A run that cannot start answers immediately with an error, which we show.
function start() {
  if (busy) return;
  busy = true;
  el.start.disabled = true;
  flushSave().then(() => {
    el.start.disabled = true;
    chrome.runtime.sendMessage({ type: 'start' }, (reply) => {
      busy = false;
      if (chrome.runtime.lastError) {
        setTestOutput('Cannot start yet', chrome.runtime.lastError.message, true);
        showStatus(state.status);
        return;
      }
      if (reply && reply.error) {
        setTestOutput('Cannot start yet', reply.error, true);
      }
      // The status line was updated live while the run went on.
      showStatus(state.status);
    });
  });
}

async function stop() {
  // Stop answers at once (it only raises a flag), so waiting is safe.
  await bgMessage({ type: 'stop' });
  el.stop.disabled = true;
}

async function copyLog() {
  const lines = (state.log || []).map((entry) =>
    Common.formatClock(entry.t) + '  ' + Common.hideSecret(entry.text, settings));
  const text = lines.length ? lines.join('\n') : 'No events yet.';
  try {
    await navigator.clipboard.writeText(text);
    el.copyLog.textContent = 'Copied!';
    setTimeout(() => { el.copyLog.textContent = 'Copy log'; }, 1500);
  } catch (err) {
    setTestOutput('Log', text, false);
  }
}

// ---------- wiring ----------
el.pickInput.addEventListener('click', () => startPick('input'));
el.pickSend.addEventListener('click', () => startPick('send'));
el.pickReply.addEventListener('click', () => startPick('reply'));
el.testCopy.addEventListener('click', testCopy);
el.testPaste.addEventListener('click', testPaste);
el.clearPicks.addEventListener('click', clearPicks);
el.makeA.addEventListener('click', () => makeRole('A'));
el.makeB.addEventListener('click', () => makeRole('B'));
el.testClose.addEventListener('click', () => { el.testOutput.hidden = true; });
el.start.addEventListener('click', start);
el.stop.addEventListener('click', stop);
el.copyLog.addEventListener('click', copyLog);
el.helperDetect.addEventListener('click', detectRoles);
el.helperRoles.addEventListener('change', renderHelper);
el.helperStop.addEventListener('change', renderHelper);
el.showReadme.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('README.html') });
});

const settingFields = [
  el.rounds, el.silence, el.copyModeA, el.copyModeB, el.markerStart, el.markerEnd,
  el.timeout, el.maxRounds, el.prefix, el.suffix, el.stopIfSame, el.stopWord,
  el.mode, el.provider, el.geminiKey, el.geminiModel, el.grokKey, el.grokModel,
  el.memory, el.systemPrompt, el.helperOn, el.helperRoles, el.helperBest,
  el.helperStop, el.goal, el.helperStopEvery, el.helperMaxCalls
];
for (const field of settingFields) {
  field.addEventListener('input', scheduleSave);
  field.addEventListener('change', scheduleSave);
}

// Live updates from the background worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.status) {
    state.status = changes.status.newValue;
    showStatus(state.status);
  }
  if (changes.log) {
    state.log = changes.log.newValue || [];
    renderLog(state.log);
  }
  if (changes.roles) {
    state.roles = changes.roles.newValue || { A: null, B: null };
    renderRoles();
  }
  // A pick was saved or cleared for the site of this tab: refresh the ticks.
  if (currentKey && changes[Common.pickStorageKey(currentKey)]) {
    currentPicks = changes[Common.pickStorageKey(currentKey)].newValue || null;
    renderPicks();
  }

  // Settings changed in another window: update the form, but never while the
  // user is typing in it (that would move the cursor around).
  if (changes.settings) {
    const next = Common.normalizeSettings(changes.settings.newValue);
    settings = next;
    const idle = !document.activeElement || document.activeElement.tagName === 'BODY';
    if (idle && !saveTimer) fillForm(next);
    renderModeBadge();
  }
});

// ---------- start up ----------
(async function init() {
  const stored = await chrome.storage.local.get(['settings', 'status', 'log', 'roles', 'run', 'helperDetect']);
  settings = Common.normalizeSettings(stored.settings);
  fillForm(settings);
  state.status = stored.status || null;
  state.log = Array.isArray(stored.log) ? stored.log : [];
  state.roles = stored.roles || { A: null, B: null };

  const background = await bgMessage({ type: 'state' });
  if (background && background.roles) state.roles = background.roles;

  showStatus(state.status);
  renderLog(state.log);
  // The last role detection stays visible, so a result is not lost when the
  // popup closes.
  if (stored.helperDetect && stored.helperDetect.message) {
    el.helperDetectResult.textContent = stored.helperDetect.message;
    el.helperDetectResult.className = 'hint detect-good';
  }
  await loadCurrentTab();
  renderRoles();
})();
