/**
 * Service worker.
 *
 * Three jobs:
 *   1. Spawn / manage the offscreen document that runs the local Whisper.
 *   2. Route messages between the content script and the offscreen doc.
 *      Content scripts can't talk to offscreen docs directly.
 *   3. When the user has selected the OpenAI API engine in the popup,
 *      forward chunks to OpenAI directly from here instead of offscreen.
 *      Cross-origin fetches from the SW respect host_permissions, so no
 *      CORS issue.
 */
import { transcribeViaApi } from './lib/openai.js';
import { getSettings } from './lib/settings.js';

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

        // Popup → content scripts: clear the IndexedDB subtitle cache (which
        // lives in the youtube.com origin, not the extension origin, so the
        // popup can't clear it directly).
        case 'clear-cache': {
          await broadcastToYtTabs({ type: 'clear-cache' });
          sendResponse({ ok: true });
          return;
        }

        case 'get-engine': {
          const s = await getSettings();
          sendResponse({ ok: true, engine: s.engine, hasApiKey: !!s.apiKey });
          return;
        }

        case 'ensure-whisper': {
          // Skip offscreen/model load entirely if user picked the API engine.
          const s = await getSettings();
          if (s.engine === 'api') {
            if (!s.apiKey) {
              sendResponse({ ok: false, error: 'OpenAI engine selected but no API key set — click the extension icon to add one.' });
              return;
            }
            sendResponse({ ok: true, engine: 'api' });
            return;
          }
          await ensureOffscreen();
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'load-model',
            modelId: msg.modelId,
          });
          sendResponse({ ok: true, engine: 'local' });
          return;
        }

        case 'transcribe-chunk': {
          const s = await getSettings();

          if (s.engine === 'api') {
            // Rebuild Float32Array from the structured-clone-flattened form.
            const samples = msg.samples instanceof Float32Array
              ? msg.samples
              : new Float32Array(Object.values(msg.samples));
            const segs = await transcribeViaApi({
              apiKey: s.apiKey,
              samples,
              task: msg.task || 'transcribe',
              language: msg.languageHint || 'no',
            });
            const offset = msg.startTime || 0;
            sendResponse({
              ok: true,
              chunkId: msg.chunkId,
              task: msg.task,
              segs: segs.map((seg) => ({
                ...seg,
                start: seg.start + offset,
                end: seg.end + offset,
              })),
            });
            return;
          }

          // Local engine: forward to offscreen.
          await ensureOffscreen();
          const result = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'transcribe-chunk',
            chunkId: msg.chunkId,
            samples: msg.samples,
            startTime: msg.startTime,
            task: msg.task,
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
