# Chat Bridge

**Make two AI chats talk to each other automatically.**

You open two AI chat tabs (for example an Arena chat and an Arena agent, or Claude and
Arena). Chat Bridge takes the newest answer from one tab, pastes only the part you want
into the other tab, presses send, waits until that AI is really finished, and repeats
for as many rounds as you choose.

It is a normal Chrome extension (Manifest V3) with **no build step, no npm packages and
no account**. Everything is stored on your own computer.

* Works on **any** website that has a chat box, because *you* show it where the parts of
  the page are by clicking them once (see [The click-to-pick system](#3-the-click-to-pick-system)).
* Works on `arena.ai/c/...` chat pages **and** `arena.ai/agent/...` agent pages. These are
  different layouts, so picks are saved separately for each one.
* Optional **API mode**: instead of a second tab, one side can be Google Gemini or xAI
  Grok, with an automatic backup provider if the first one fails.

## What is in this repository

| Path | What it is |
| --- | --- |
| **`extension/`** | The Chrome extension. **This is the folder you load into Chrome.** Everything it needs is inside. |
| `SOURCE.md` | Every source file of the extension in one document, if you prefer to read or copy it from a single page. |
| `dev/` | The automated test suite. Not needed to use the extension. |
| `package.json` | Only for running the tests (`npm install`). The extension needs no packages. |

**Build status — all four stages are finished and tested:**

| Stage | What it covers | State |
| --- | --- | --- |
| 1 | Popup, click-to-pick, Test copy, Test paste | ready |
| 2 | Roles, the tab-to-tab loop, wait-until-done | ready |
| 3 | Prefix/suffix, the three copy modes, stop options | ready |
| 4 | API mode (Gemini + Grok) with automatic fallback | ready |

---

## 1. Install (about one minute)

1. Download or copy this folder to your computer. The extension lives in the
   **`extension/`** folder of this project.
2. Open Chrome and type `chrome://extensions` in the address bar.
3. Turn on **Developer mode** (the switch in the top right corner).
4. Press **Load unpacked**.
5. Choose the **`extension`** folder (the one that contains `manifest.json`).
6. The Chat Bridge icon (two speech bubbles) appears in your toolbar. Pin it with the
   puzzle-piece icon so it is always visible.

> If the icon is grey or the popup says "This is a browser page", switch to a normal
> website tab first. Chrome does not let extensions work on `chrome://` pages.

---

## 2. Quick start (3 rounds, two Arena tabs)

1. Open your **first** chat tab, for example `https://arena.ai/c/...`, and right-click
   the toolbar icon → open the popup (or just click the icon).
2. In the popup, press **Pick chat box**, then click once inside the message box of the
   page. You will see a toast: "Hover, press Arrow Up for a bigger area, Arrow Down to go
   back, click to choose, Esc to cancel."
3. Press **Pick send button** and click the send arrow.
4. Press **Pick AI reply** and click on the AI's answer. **Important:** click the text of
   an answer, then press **Arrow Up** once or twice until the blue box covers the whole
   answer bubble, then click. The popup shows what was saved and how many replies it
   matches.
5. Press **Test copy**. You should see the first 200 characters of the newest answer.
6. Press **Test paste**. The word `test` appears in the chat box (it is **not** sent).
   Delete it.
7. Press **Make this Tab A**.
8. Open your **second** chat tab (for example `https://arena.ai/agent/...`) and repeat
   steps 2–7, but press **Make this Tab B** at the end. Agent pages show only the newest
   answer while they work, so pick the reply again after the agent has finished one.
9. Back in the first tab's popup, set **Rounds** to `3`, choose a **Copy mode** for A and
   B, then press **Start**.

Watch the status line. It tells you exactly what is happening: "Round 1/3: sending A → B",
"waiting for B to finish (12s of 20s silence)", "Done".

> **Tip:** Chrome can slow down or pause hidden tabs, and some sites refuse pasted text
> in a background tab. For the most reliable run, put the two chat tabs in **two separate
> Chrome windows**, side by side.

---

## 3. The click-to-pick system

Chat bridge does not know any website in advance. You teach it three spots per site:

| Spot | What to click | Notes |
| --- | --- | --- |
| Chat box | inside the message box | Arrow Up if you clicked a small inner part |
| Send button | the send arrow/button | Optional. If you skip it, Enter is pressed instead |
| AI reply | the AI's answer text | Must match **every** answer, not just one |

While picking:

* a **blue box** follows your mouse and the tag name is shown above it;
* **Arrow Up** selects a bigger area (the parent), **Arrow Down** goes back;
* **click** to save, **Esc** to cancel;
* the website does not receive your clicks or keys while you pick.

Picks are saved per **site key** = the address plus the first path part, so for example:

* `https://arena.ai/c` (Arena chat)
* `https://arena.ai/agent` (Arena agent)
* `https://claude.ai/chat`
* `https://gemini.google.com/app`

`arena.ai/c` and `arena.ai/agent` are stored **separately**, because their layouts differ.
Two chats on the same site share one set of picks, which is exactly what you want in
tab-to-tab mode.

### When the AI reply is picked

The extension always reads the **last** element that matches the reply selector, so brand
new answers are found with no extra work. The saved selector never uses a position such as
"the third message" — it uses stable attributes and class names:

1. `data-testid`, `data-message-author-role`, `data-role`, `aria-label`, `placeholder`, `role`
2. tag + stable class names (random names like `css-1x2y3z` or `sc-kfzBvf` are ignored)
3. a stable parent plus the child path, for example `div[data-message-author-role="assistant"] > p`
4. as the very last resort for the chat box and send button only, a full
   `nth-of-type` path.

For the reply, a selector that only matches one message is **refused** when the page
clearly has several messages — you get a message asking you to press Arrow Up and click
again.

---

## 4. The three copy modes

Each side (A and B) has its own copy mode:

1. **Full reply** — everything the AI wrote.
2. **Last code block** — the newest `<pre><code>` block. If there is none the run stops and
   says "No code block found in the last reply."
3. **Between markers** — the text between a START and an END marker (default words
   `START` and `END`, you can change them). The extension uses the **last** START and the
   first END after it. This is the cleanest way to keep the two AIs on topic: tell each AI
   "Put the message for the other AI between START and END", and only that part travels.

**Prefix** and **suffix** are added before and after every forwarded message. A common
setup:

* Prefix: `Here is the other AI's answer. Improve it.`
* Suffix: `Reply with your next message, wrapped between START and END.`

So a forwarded message looks like:

```
Here is the other AI's answer. Improve it.

<the part you chose>

Reply with your next message, wrapped between START and END.
```

---

## 5. Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Rounds | 5 | One round = A → B and back to A |
| Seconds of silence | 8 | How long the reply must stay unchanged before it counts as finished |
| Copy mode A / B | Full reply | See above |
| START / END markers | `START` / `END` | Shared by both sides |
| Prefix / Suffix | empty | Added around every forwarded message |
| Timeout (seconds) | 600 | Give up after this long and say "Timed out waiting for Tab X" |
| Max rounds safety limit | 100 | Hard cap, so a typo cannot start 10 000 rounds |
| Stop if the new reply is identical to the previous one | off | Catches two AIs repeating themselves |
| Stop when the reply contains | empty | For example `DONE` |

**Seconds of silence:** use the default 8 for normal chat pages. For **Arena agent mode**
use **20 to 30**, because an agent goes quiet while it runs tools and would otherwise look
"finished" too early. The extension also notices an unclosed code block (```` ``` ```` with
no closing fence) and doubles the wait, which catches agents that are still writing code.

---

## 6. API mode (Gemini / Grok instead of a second tab)

Set **Mode** to *Tab and API*. Tab A is your normal chat tab; the other side is an AI API.
The API's answer is pasted into Tab A and sent, Tab A answers, and its answer goes back to
the API, for the chosen number of rounds.

1. Get a key:
   * Gemini: <https://aistudio.google.com/apikey>
   * Grok: <https://console.x.ai>
2. Paste the key into the popup's **Settings** (the fields are password fields).
3. Choose the **main provider**. The other one becomes the automatic backup.

**Fallback rule.** If the main provider returns HTTP 429 (rate limit), 401/403, 5xx, a
network error, or an empty answer, Chat Bridge waits 2 seconds and tries once more. If that
also fails it switches to the backup provider for that request. A provider that answered
429 rests for 60 seconds. If both fail, the run stops with a plain message. The status line
and the log always say which provider answered.

Endpoints used (checked against the official documentation):

* Gemini: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,
  header `x-goog-api-key`, body `{ systemInstruction, contents: [{role, parts}] }`,
  default model `gemini-2.5-flash`.
* Grok: `POST https://api.x.ai/v1/chat/completions`, header `Authorization: Bearer <key>`,
  body `{ model, messages }` (OpenAI compatible), default model `grok-4`.

The model names are editable text fields, so you can switch to a newer model any time.
Memory (default 6 messages) and an optional system prompt are sent with every request so the
API understands the conversation.

**Your keys never leave this browser** except in the requests to the provider you chose.
They are stored in `chrome.storage.local`, never logged, and hidden as `[hidden key]` if a
server ever echoes one back.

---

## 7. Common problems

| Problem | What to do |
| --- | --- |
| "Chat box not found. The page may have changed" | The site was redesigned. Press **Clear picks** and pick the three spots again. |
| "The chat box stayed empty after pasting" | You clicked a wrapper, not the real box. Pick again and click directly inside the box. |
| Pasted text appears but the message never sends | The send button is a different element. Pick **Pick send button** again, clicking the arrow itself. |
| The loop says "Timed out waiting for Tab B" | 1) Put both chats in two separate Chrome windows. 2) Raise **Seconds of silence**. 3) Raise **Timeout**. 4) Check that you picked the **AI reply**, not the user message. |
| The AI answer is cut in half | The reply selector matches a small inner part. Re-pick the reply, pressing Arrow Up so the blue box covers the whole answer. |
| "It matches 1 reply right now" is wrong | Re-pick and press Arrow Up until it says "matches N replies". |
| Agent mode stops too early | Raise **Seconds of silence** to 20–30. |
| "No code block found in the last reply" | That answer has no code. Change the copy mode or use markers. |
| "I could not find the START marker" | Tell the AI to wrap its message between the marker words you set. |
| "Run was interrupted" | Chrome restarted the extension in the background. Press **Start** again. |
| The popup shows the wrong site | The popup always describes the **tab that is active** when you open it. Click the tab you want, then open the popup again. |
| Nothing works on a `chrome://` page, the Chrome Web Store, or a PDF | Chrome blocks extensions there. Use a normal website tab. |
| API mode says "the API key was rejected" | Check the key was copied fully and that it belongs to the provider you chose. |
| API mode says "the free quota or rate limit is used up" | Wait a minute, or make the other provider the main one. The backup is used automatically. |

---

## 8. Test plan

Run these in order. Each one checks a different part of the machinery.

**Test 1 — Arena chat talks to Arena agent (the main case)**

1. Open `https://arena.ai/c/...` and `https://arena.ai/agent/...` in two windows.
2. Pick the three spots in each tab (agent: pick the reply after it has answered once).
3. Both: copy mode = **Between markers**, markers `START` / `END`.
4. Prefix: `Here is the other AI's answer. Improve it. Reply between START and END.`
5. Rounds `3`, silence `8` for the chat, **create the run from the /c tab**.
6. Press Start. Expected: six sends (A→B, B→A three times), status finishes with
   "Finished all 3 rounds.", and each forwarded message contains only the marked part.

**Test 2 — Claude talks to Arena**

Same steps, one tab on `https://claude.ai/chat/...`, one on `https://arena.ai/c/...`.
This proves the generic picker works on a site it has never seen.

**Test 3 — two tabs of the same site**

Open two different `arena.ai/c/...` chats. Both use the same saved picks (one site key),
which is expected. Start the run and check that each tab still finds its own reply.

**Test 4 — stop and errors**

* Press **Stop** mid-run: the status becomes "Stopped by you." within a second.
* Set the START marker to something that never appears: the run stops with a clear
  "I could not find the START marker" message.
* Pick the wrong element as the chat box: **Test paste** tells you the box stayed empty.

**Test 5 — API mode**

* Mode = *Tab and API*, main provider Gemini, a wrong Gemini key, a correct Grok key.
  Expected: the log says Gemini failed, then "The answer came from Grok instead."
* Both keys wrong: the run stops with "Both API providers failed."

---

## 9. Folder structure (ZIP ready)

```
Chat-Bridge/
├── manifest.json        <- the extension description Chrome reads
├── background.js        <- the service worker: runs the loop
├── content.js           <- runs in every page: picker, paste, send, read reply
├── selectors.js         <- builds the saved CSS selectors
├── extract.js           <- the three copy modes
├── api-client.js        <- Gemini and Grok, with fallback
├── common.js            <- shared helpers and default settings
├── popup.html           <- the popup window
├── popup.js             <- popup logic
├── popup.css            <- popup styles
├── README.html          <- "How to use" inside the popup
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

To zip it: select everything inside `extension/` (not the folder itself) and zip it, or zip
the `extension` folder and rename the zip to `Chat-Bridge.zip`. Either way, `manifest.json`
must be at the top level of what you load.

The repository also contains `dev/` (the automated tests) and `package.json`. Those are
**not** part of the extension and are not needed to install it.

---

## 10. For developers: the tests

The extension itself has zero dependencies. The test suite uses Node's built-in test
runner plus `jsdom` (a headless DOM), and exercises the **real** extension files:

```bash
npm install     # installs jsdom, only for the tests
npm test
```

What is covered (108 tests):

* `selectors.test.js` — hash classes are rejected, replies match every answer, ids with
  digits are ignored, the structural fallback works.
* `extract.test.js` — the three copy modes, marker edge cases, unfinished-code detection.
* `common.test.js` — site keys (`/c` vs `/agent`), defaults, clamping, key hiding.
* `api-client.test.js` — request shapes for both providers, retry once, fallback, 429
  cooldown, empty answers, both-fail message.
* `content.test.js` — the real `content.js` in a page: React-safe textarea fill,
  contenteditable insert, Enter fallback, disabled send button, multi-line text.
* `picker.test.js` — the real picker: hover, Arrow Up/Down, click to save, Esc to cancel,
  and that the page never receives the clicks.
* `popup.test.js` — the real `popup.html` in jsdom: every control, saving settings, ticks,
  Start/Stop wiring, plain-language errors.
* `loop.test.js` — the real `background.js` loop end to end: 2 rounds between two fake
  pages, copy modes, prefix/suffix, Stop, timeout, stop-word, loop detection, replies that
  start empty, content-script re-injection, API mode with fallback, and API memory that
  always starts with the user's turn.

There is also `dev/smoke.js`, which checks that the manifest is complete, every file it
names exists, all JavaScript parses, the service worker can load its helpers, no API key
is hard-coded, and the icons are real PNGs:

```bash
npm run smoke     # or: node dev/smoke.js
```

---

## Licence

Do whatever you like with it. No warranty; use it at your own risk.
