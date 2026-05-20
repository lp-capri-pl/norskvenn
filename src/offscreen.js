/**
 * Whisper inference runtime, hosted in an offscreen document.
 *
 * Why offscreen? MV3 service workers get killed after 30 seconds of idle, and
 * transformers.js's WASM runtime cannot survive that. An offscreen document is
 * a persistent DOM context the extension owns, lives across navigations, and
 * can run heavy WASM workloads.
 *
 * Each chunk arrives as a Float32Array of 16-kHz mono samples. We run Whisper
 * twice on it: once in transcribe mode (Norwegian) and once in translate mode
 * (→ English). The two segment streams get returned to the content script,
 * which renders the bilingual overlay.
 */

import { pipeline, env } from '@huggingface/transformers';

// transformers.js by default tries to load its ORT WASM glue (.wasm + .mjs)
// from cdn.jsdelivr.net, which Chrome extension CSP blocks. We bundle those
// artifacts into /ort/ at build time (see vite.config.js copyOrtAssets) and
// point the runtime at them here.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');
// Single-threaded keeps things simple. Multi-thread WASM needs
// crossOriginIsolated + COOP/COEP headers which extensions don't easily get.
env.backends.onnx.wasm.numThreads = 1;

env.allowLocalModels = false;
env.allowRemoteModels = true;
// Models stream from huggingface.co — host_permissions in manifest grants this.

let transcribe = null;       // pipeline instance
let translate = null;
let loadedModelId = null;

// Serialize all Whisper inference calls. ONNX Runtime sessions can't safely
// run two inferences concurrently — calling transcribe() while a previous
// call is still in flight either silently queues, deadlocks, or returns
// garbage depending on backend. We've seen WebGPU deadlock in practice.
let inferenceQueue = Promise.resolve();
function serialize(fn) {
  const result = inferenceQueue.then(fn, fn);
  inferenceQueue = result.catch(() => {});  // never let queue die from one bad call
  return result;
}

function broadcastProgress(data) {
  // Fan out to the active YouTube tab(s) via the background. Content
  // scripts can't receive chrome.runtime.sendMessage broadcasts directly,
  // so background has a 'whisper-progress' router.
  chrome.runtime
    .sendMessage({ target: 'background', type: 'whisper-progress', data })
    .catch(() => {}); // ignore "no receiving end" during reload
}

async function loadModel(modelId) {
  if (loadedModelId === modelId && transcribe && translate) return;

  const cb = (p) => broadcastProgress(p);

  // Try fastest path first, fall back when unavailable. Whisper is a
  // dual-model architecture (encoder + decoder) and the encoder is the
  // unstable part on WebGPU when quantized. The recipe that actually works
  // is fp32 encoder + q4 decoder — decoder is most of the weights so we
  // still get the size benefit, and the encoder stays stable.
  const attempts = [
    {
      device: 'webgpu',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      label: 'WebGPU enc=fp32 dec=q4',
    },
    {
      device: 'webgpu',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
      label: 'WebGPU all fp32',
    },
    { device: 'wasm', dtype: 'q8', label: 'WASM q8 (slow)' },
  ];

  let lastErr;
  for (const a of attempts) {
    try {
      console.log(`[offscreen] trying ${a.label}…`);
      broadcastProgress({ status: 'init', label: a.label });
      transcribe = await pipeline('automatic-speech-recognition', modelId, {
        device: a.device,
        dtype: a.dtype,
        progress_callback: cb,
      });
      console.log(`[offscreen] loaded via ${a.label}`);
      broadcastProgress({ status: 'ready', label: a.label });
      break;
    } catch (e) {
      console.warn(`[offscreen] ${a.label} failed:`, e?.message || e);
      lastErr = e;
    }
  }
  if (!transcribe) throw lastErr || new Error('all backends failed');

  translate = transcribe;
  loadedModelId = modelId;
}

async function runOne(samples, task, languageHint) {
  // samples: Float32Array @ 16kHz mono
  // languageHint: 'no' to force Norwegian, null to let Whisper auto-detect
  //   (useful for mixed-language content like language-lesson videos where
  //    forcing 'no' makes Whisper hallucinate Norwegian out of English audio).
  const opts = {
    task,                        // 'transcribe' or 'translate'
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    do_sample: false,
    // Whisper-base is prone to "er det som er det som er det som…" loops
    // when forced to transcribe music/noise as speech. no_repeat_ngram_size
    // forbids the same 3-gram from appearing back-to-back during decoding,
    // which breaks those loops at the cost of a tiny accuracy hit on
    // intentionally-repeated phrases.
    no_repeat_ngram_size: 3,
  };
  if (languageHint) opts.language = languageHint;

  console.log(`[offscreen] runOne START task=${task} lang=${languageHint || 'auto'} samples=${samples.length}`);
  const t0 = performance.now();
  const result = await transcribe(samples, opts);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[offscreen] runOne DONE task=${task} in ${elapsed}s result:`, result);

  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  const durationSec = samples.length / 16000;

  const parsed = chunks
    .map((c) => ({
      start: Array.isArray(c.timestamp) ? (c.timestamp[0] ?? 0) : 0,
      end:
        Array.isArray(c.timestamp)
          ? (c.timestamp[1] ?? c.timestamp[0] ?? durationSec)
          : durationSec,
      text: (c.text || '').trim(),
    }))
    .filter((s) => s.text && !looksDegenerate(s.text));

  if (parsed.length) return parsed;

  const fullText = (result?.text || '').trim();
  if (fullText && !looksDegenerate(fullText)) {
    return [{ start: 0, end: durationSec, text: fullText }];
  }

  return [];
}

/**
 * Heuristic: detect Whisper's notorious repetition hallucinations like
 *   "er det som er det som er det som er det som…"
 * Returns true if the text looks degenerate and should be dropped.
 */
function looksDegenerate(text) {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 8) return false;
  // Vocabulary ratio: how many unique words vs total. <20 % = stuck loop.
  const unique = new Set(words);
  if (unique.size / words.length < 0.2) return true;
  // Same word back-to-back many times: "the the the the the".
  let maxRun = 1, run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  if (maxRun >= 5) return true;
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  console.log(`[offscreen] ← msg type=${msg.type} chunkId=${msg.chunkId ?? '-'} task=${msg.task ?? '-'}`);

  (async () => {
    try {
      switch (msg.type) {
        case 'load-model': {
          await loadModel(msg.modelId || 'Xenova/whisper-base');
          sendResponse({ ok: true });
          return;
        }

        case 'transcribe-chunk': {
          // ensure-whisper should have loaded this already; this is just a safety net.
          if (!transcribe) await loadModel(msg.modelId || 'Xenova/nb-whisper-base-beta');
          const samples = new Float32Array(Object.values(msg.samples));
          const task = msg.task || 'transcribe';        // 'transcribe' or 'translate'
          const langHint = msg.languageHint ?? 'no';
          // Push into the serial queue so concurrent chunk messages don't
          // race the underlying ONNX session.
          const segs = await serialize(() => runOne(samples, task, langHint));
          const offset = msg.startTime || 0;
          sendResponse({
            ok: true,
            chunkId: msg.chunkId,
            task,
            segs: segs.map((s) => ({
              ...s,
              start: s.start + offset,
              end: s.end + offset,
            })),
          });
          return;
        }

        default:
          sendResponse({ ok: false, error: `unknown type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[offscreen] error', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true;
});
