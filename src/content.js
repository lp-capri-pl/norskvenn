/**
 * Content script — injected into every youtube.com page.
 *
 * Responsibilities:
 *   1. Detect watch pages (?v=…) and re-init on YouTube's SPA navigations.
 *   2. Inject a "🇳🇴 Live subs" button next to the video controls.
 *   3. When clicked: start capturing the player's audio, ship 30-second
 *      chunks to the background → offscreen pipeline for Whisper, and stream
 *      results back into an overlay rendered on top of the player.
 *   4. Cache completed transcripts in IndexedDB keyed by videoId.
 */

import { AudioCapturer } from './lib/audio.js';
import { loadSubs, saveSubs } from './lib/cache.js';
import { bilingualSrt } from './lib/srt.js';

// whisper-base is the speed/quality sweet spot for live transcription in
// browser. On consumer GPUs, whisper-small takes 30-60s per 10s chunk
// (impossibly slow — subs are obsolete by the time they arrive). Base is
// ~3x faster and good enough for follow-along language learning.
// To upgrade: 'Xenova/whisper-small' (240MB, better NO but needs strong GPU).
const MODEL_ID = 'Xenova/whisper-base';
const MODEL_SIZE_MB = 75;
const BTN_ID = 'norskvenn-btn';
const OVERLAY_ID = 'norskvenn-overlay';

let state = {
  videoId: null,
  active: false,
  capturer: null,
  noSegs: [],
  enSegs: [],
  chunkSeq: 0,
};

// ---------- helpers ----------

function getVideoIdFromUrl() {
  const u = new URL(location.href);
  if (u.pathname === '/watch') return u.searchParams.get('v');
  return null;
}

function $video() { return document.querySelector('video.html5-main-video'); }

function tellBg(msg) {
  return chrome.runtime.sendMessage({ target: 'background', ...msg });
}

// ---------- button injection ----------

function injectButton() {
  if (document.getElementById(BTN_ID)) return;
  // The right-side action bar above the player title.
  const host =
    document.querySelector('#actions #top-level-buttons-computed') ||
    document.querySelector('#actions-inner') ||
    document.querySelector('#above-the-fold');
  if (!host) return false;

  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.className = 'norskvenn-btn';
  btn.type = 'button';
  btn.textContent = '🇳🇴 Live subs';
  btn.addEventListener('click', onToggle);
  host.prepend(btn);
  return true;
}

function injectOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = OVERLAY_ID;
  el.className = 'norskvenn-overlay';
  el.innerHTML = `
    <div class="norskvenn-status"></div>
    <div class="norskvenn-lag"></div>
    <div class="norskvenn-cue" title="Drag to reposition">
      <div class="norskvenn-no"></div>
      <div class="norskvenn-en"></div>
    </div>
  `;
  // Mount inside the player container so it inherits fullscreen sizing.
  const player = document.querySelector('#movie_player') || document.body;
  player.appendChild(el);
  makeCueDraggable(el.querySelector('.norskvenn-cue'));
  return el;
}

// Drag the cue around the player. Position is saved as a percentage of the
// player's box so it survives window resizes and fullscreen toggles.
function makeCueDraggable(cue) {
  const STORAGE_KEY = 'norskvenn:cue-pos';

  const applyPos = (xPct, yPct) => {
    cue.style.position = 'absolute';
    cue.style.left = `${xPct}%`;
    cue.style.top = `${yPct}%`;
    cue.style.bottom = 'auto';
    cue.style.right = 'auto';
    cue.style.transform = 'translate(-50%, -50%)';
  };

  // Restore previous position (if any).
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      applyPos(saved.x, saved.y);
    }
  } catch {}

  let dragging = false;
  let offsetX = 0, offsetY = 0;   // mouse offset relative to cue center

  cue.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    const cueRect = cue.getBoundingClientRect();
    const cx = cueRect.left + cueRect.width / 2;
    const cy = cueRect.top + cueRect.height / 2;
    offsetX = e.clientX - cx;
    offsetY = e.clientY - cy;
    cue.classList.add('dragging');
    // Don't let YouTube pause/seek when the user clicks the cue.
    e.preventDefault();
    e.stopPropagation();
  });

  const onMove = (e) => {
    if (!dragging) return;
    const parentRect = cue.parentElement.getBoundingClientRect();
    // Center of the cue, expressed as a % of the parent box.
    const xPct = ((e.clientX - offsetX - parentRect.left) / parentRect.width) * 100;
    const yPct = ((e.clientY - offsetY - parentRect.top) / parentRect.height) * 100;
    // Clamp inside the player so the cue can't drift off-screen.
    const clamp = (v) => Math.max(2, Math.min(98, v));
    applyPos(clamp(xPct), clamp(yPct));
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    cue.classList.remove('dragging');
    // Persist current position in % so it carries across resize / fullscreen.
    const m = /([\d.]+)%/;
    const x = parseFloat(cue.style.left);
    const y = parseFloat(cue.style.top);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  // Double-click to reset to default (bottom-center).
  cue.addEventListener('dblclick', (e) => {
    localStorage.removeItem(STORAGE_KEY);
    cue.style.position = '';
    cue.style.left = '';
    cue.style.top = '';
    cue.style.bottom = '';
    cue.style.right = '';
    cue.style.transform = '';
    e.stopPropagation();
  });
}

function setStatus(text) {
  const el = document.getElementById(OVERLAY_ID);
  if (!el) return;
  el.querySelector('.norskvenn-status').textContent = text || '';
}

function renderCue() {
  const el = document.getElementById(OVERLAY_ID);
  if (!el || !state.active) return;
  const t = $video()?.currentTime ?? 0;

  // Primary: subtitle whose [start, end] window contains the current playback
  // time. Falls back to the most-recently-transcribed segment if we're
  // running behind — better to show stale text than nothing.
  const pickActive = (segs) => {
    if (!segs.length) return { seg: null, stale: false };
    const cur = segs.find((s) => t >= s.start && t <= s.end + 0.4);
    if (cur) return { seg: cur, stale: false };
    // Latest segment whose start time is <= now (i.e. content already played).
    let latest = null;
    for (const s of segs) {
      if (s.start <= t && (!latest || s.start > latest.start)) latest = s;
    }
    return { seg: latest || segs[segs.length - 1], stale: true };
  };

  const no = pickActive(state.noSegs);
  const en = pickActive(state.enSegs);

  const noEl = el.querySelector('.norskvenn-no');
  const enEl = el.querySelector('.norskvenn-en');
  noEl.textContent = no.seg?.text || '';
  enEl.textContent = en.seg?.text || '';
  noEl.classList.toggle('stale', no.stale);
  enEl.classList.toggle('stale', en.stale);

  // If we're behind, surface "(Xs behind)" so user understands the lag.
  const latestEnd = state.noSegs.length
    ? state.noSegs[state.noSegs.length - 1].end
    : 0;
  const lag = Math.max(0, t - latestEnd);
  el.querySelector('.norskvenn-lag').textContent =
    lag > 5 ? `subs lagging ${lag.toFixed(0)}s behind playback` : '';
}

// ---------- transcription flow ----------

async function onToggle() {
  if (state.active) {
    stop();
    return;
  }
  await start();
}

async function start() {
  const video = $video();
  if (!video) {
    alert('Norskvenn: no video element found yet — press play first.');
    return;
  }
  if (video.paused) {
    // captureStream needs an audio track, which only appears once playback
    // has actually started. Kick it.
    try { await video.play(); } catch {}
  }

  state.videoId = getVideoIdFromUrl();
  state.active = true;
  state.noSegs = [];
  state.enSegs = [];
  state.chunkSeq = 0;
  injectOverlay();
  setStatus(`Loading Whisper ${MODEL_ID.split('/')[1]}… (first run downloads ~${MODEL_SIZE_MB} MB)`);
  document.getElementById(BTN_ID).textContent = '⏹ Stop subs';
  document.getElementById(BTN_ID).classList.add('active');

  // Replay any cached partial result.
  const cached = await loadSubs(state.videoId);
  if (cached) {
    state.noSegs = cached.no || [];
    state.enSegs = cached.en || [];
    setStatus(cached.complete ? 'Loaded cached subs' : 'Resuming…');
  }

  const res = await tellBg({ type: 'ensure-whisper', modelId: MODEL_ID });
  if (!res?.ok) {
    setStatus(`Whisper load failed: ${res?.error || 'unknown'}`);
    return stop();
  }
  setStatus('Capturing audio…');

  state.capturer = new AudioCapturer(video, {
    onChunk: handleChunk,
  });
  try {
    await state.capturer.start();
  } catch (err) {
    setStatus(`Audio capture failed: ${err.message}`);
    return stop();
  }
}

async function handleChunk(samples, startTime) {
  const id = ++state.chunkSeq;

  // Two passes: Norwegian first so users see *something* ~50% sooner,
  // English translation follows. Each runs as a separate background
  // message — both share the same Whisper pipeline so they serialize
  // at the ONNX session anyway, but issuing them separately lets us
  // render NO subs as soon as they arrive.
  const liveCount = () =>
    `${state.noSegs.length} NO · ${state.enSegs.length} EN`;

  setStatus(`Chunk ${id} → transcribing NO… (${liveCount()})`);
  const noRes = await tellBg({
    type: 'transcribe-chunk',
    chunkId: id,
    samples,
    startTime,
    task: 'transcribe',
    languageHint: 'no',
  });
  if (!noRes?.ok) {
    setStatus(`Chunk ${id} NO failed: ${noRes?.error || 'unknown'}`);
    return;
  }
  state.noSegs.push(...noRes.segs);
  setStatus(`Chunk ${id} → translating EN… (${liveCount()})`);

  const enRes = await tellBg({
    type: 'transcribe-chunk',
    chunkId: id,
    samples,
    startTime,
    task: 'translate',
    languageHint: 'no',
  });
  if (enRes?.ok) state.enSegs.push(...enRes.segs);

  await saveSubs(state.videoId, {
    no: state.noSegs,
    en: state.enSegs,
    complete: false,
  });
  setStatus(liveCount());
}

function stop() {
  state.active = false;
  state.capturer?.stop();
  state.capturer = null;
  if (state.videoId && state.noSegs.length) {
    saveSubs(state.videoId, {
      no: state.noSegs,
      en: state.enSegs,
      complete: false,  // user stopped mid-stream
    });
  }
  const btn = document.getElementById(BTN_ID);
  if (btn) {
    btn.textContent = '🇳🇴 Live subs';
    btn.classList.remove('active');
  }
  setStatus('Stopped. Click again to resume.');
}

// ---------- progress messages from offscreen ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'whisper-progress') return;
  const d = msg.data || {};
  // Possible shapes from transformers.js progress_callback:
  //   { status: 'init', label }                           — our own marker
  //   { status: 'initiate' | 'download', file, name }     — start of a file
  //   { status: 'progress', file, loaded, total, progress }
  //   { status: 'done', file }
  //   { status: 'ready', label }                          — our own marker
  if (d.status === 'init') {
    setStatus(`Loading model (${d.label})…`);
  } else if (d.status === 'progress' && typeof d.progress === 'number') {
    const mb = d.total ? ` (${(d.loaded / 1e6).toFixed(0)}/${(d.total / 1e6).toFixed(0)} MB)` : '';
    setStatus(`Downloading ${d.file || ''}: ${d.progress.toFixed(0)}%${mb}`);
  } else if (d.status === 'done' && d.file) {
    setStatus(`Downloaded ${d.file}`);
  } else if (d.status === 'ready') {
    setStatus(`Model ready (${d.label}). Capturing audio…`);
  }
});

// ---------- SPA-aware bootstrap ----------

let lastPath = location.href;

function tick() {
  if (location.href !== lastPath) {
    lastPath = location.href;
    if (state.active) stop();
    // Clear the cue between videos.
    const ov = document.getElementById(OVERLAY_ID);
    if (ov) {
      ov.querySelector('.norskvenn-no').textContent = '';
      ov.querySelector('.norskvenn-en').textContent = '';
    }
  }
  if (getVideoIdFromUrl() && !document.getElementById(BTN_ID)) {
    injectButton();
  }
  renderCue();
}

setInterval(tick, 250);
// First pass.
tick();
