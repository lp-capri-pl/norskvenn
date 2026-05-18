/**
 * Service worker.
 *
 * Two jobs:
 *   1. Spawn / manage the offscreen document that runs Whisper.
 *   2. Route messages between the content script and the offscreen doc.
 *      Content scripts can't talk to offscreen docs directly — only the
 *      service worker can.
 */

const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen.html');

let creating = null;

async function ensureOffscreen() {
  // hasDocument() exists in Chrome 116+.
  const exists = await chrome.offscreen.hasDocument?.();
  if (exists) return;

  if (creating) return creating;

  creating = chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['WORKERS'],   // running heavy WASM workloads
    justification:
      'Whisper ASR (transformers.js + onnxruntime-web) needs a persistent ' +
      'DOM context — the service worker is killed after 30s of idle.',
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

async function broadcastToYtTabs(msg) {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  await Promise.all(
    tabs.map((t) =>
      chrome.tabs.sendMessage(t.id, msg).catch(() => {}),
    ),
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return;

  (async () => {
    try {
      switch (msg.type) {
        // Offscreen → content script: forward model-load progress events.
        case 'whisper-progress': {
          await broadcastToYtTabs({ type: 'whisper-progress', data: msg.data });
          sendResponse({ ok: true });
          return;
        }

        case 'ensure-whisper': {
          await ensureOffscreen();
          // Tell the offscreen to preload the model.
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'load-model',
            modelId: msg.modelId,
          });
          sendResponse({ ok: true });
          return;
        }

        case 'transcribe-chunk': {
          await ensureOffscreen();
          const result = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'transcribe-chunk',
            chunkId: msg.chunkId,
            samples: msg.samples,        // Float32Array (16kHz mono)
            startTime: msg.startTime,
            task: msg.task,              // 'transcribe' | 'translate'
            languageHint: msg.languageHint,
          });
          sendResponse(result);
          return;
        }

        default:
          sendResponse({ ok: false, error: `unknown type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[bg] error', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true; // keep sendResponse alive across the async work
});
