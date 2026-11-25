// dev/fake-page.js
// A fake chat website made of plain objects (no browser needed).
// It behaves like a real page for the background worker tests:
//   * it has a chat box, a send button and AI replies that match a selector
//   * when a message is sent, a reply starts and grows over a few "ticks"
// This lets us test "wait until the AI is finished" without a browser.
'use strict';

function makePage(options) {
  const opts = Object.assign({
    replies: ['Hello, I am ready.'],
    tickMs: 20,       // how long one growth step takes
    steps: 4,         // how many growth steps a reply takes
    replyDelay: 2,    // how many reads happen before the reply starts growing
    codeBlock: false, // add a code block to each reply
    wrap: (text) => text,
    broken: false     // reply selector stops matching (page changed)
  }, options);

  const page = {
    replies: opts.replies.slice(),
    incoming: [],
    sends: 0,
    pasteCalls: 0,
    reads: 0,
    pending: null, // { full, shown, stepsLeft }
    __injected: false
  };

  function currentReplyText() {
    if (opts.broken) return null;
    if (!page.replies.length) return null;
    return page.replies[page.replies.length - 1];
  }

  // Each read advances the fake "AI typing".
  page.__handle = async function handle(message) {
    if (message.type === 'readReply') {
      page.reads += 1;
      if (page.pending) {
        if (opts.neverFinish) {
          // Keep adding a character on every read, so the text never settles.
          page.pending.shown = page.pending.full + ' ' + 'x'.repeat(page.reads);
          page.replies[page.replies.length - 1] = opts.wrap(page.pending.shown);
        } else if (page.pending.delay > 0) {
          page.pending.delay -= 1;
        } else if (page.pending.stepsLeft > 0) {
          page.pending.stepsLeft -= 1;
          const shownLength = Math.min(page.pending.full.length,
            page.pending.shown.length + Math.ceil(page.pending.full.length / (opts.steps + 1)));
          page.pending.shown = page.pending.full.slice(0, shownLength);
          page.replies[page.replies.length - 1] = opts.wrap(page.pending.shown);
          if (page.pending.stepsLeft === 0) {
            page.replies[page.replies.length - 1] = opts.wrap(page.pending.full);
            page.pending = null;
          }
        }
      }
      if (opts.broken) return { ok: false, count: 0, error: 'The AI reply was not found on the page.' };
      return {
        ok: true,
        count: page.replies.length,
        text: currentReplyText() || '',
        code: opts.codeBlock ? '```\ncode from reply ' + page.replies.length + '\n```' : ''
      };
    }

    if (message.type === 'deliver') {
      page.sends += 1;
      page.pasteCalls += 1;
      page.incoming.push(message.text);
      // Start a new reply that grows over several reads.
      const answer = opts.answerFor ? opts.answerFor(message.text, page.sends) : 'Answer number ' + page.sends;
      const full = opts.codeBlock ? answer + '\n```\nconst x = ' + page.sends + ';\n```' : answer;
      page.replies.push('');
      page.pending = { full, shown: '', stepsLeft: opts.steps, delay: opts.replyDelay };
      return { ok: true };
    }

    if (message.type === 'getSiteState') {
      return { ok: true, picks: { input: true, send: true, reply: true } };
    }

    return { error: 'fake page does not know ' + message.type };
  };

  page.__inject = function inject() {
    page.__injected = true;
  };

  return page;
}

module.exports = { makePage };
