/**
 * Read/write user-facing settings (engine + API key) via chrome.storage.local.
 * chrome.storage is per-extension, encrypted at rest, and survives reloads.
 */

const DEFAULTS = {
  engine: 'local',         // 'local' | 'api'
  apiKey: '',
  // Manual timing nudge applied in renderCue. Positive = subs appear earlier
  // (use when subs lag the spoken word). Negative = subs appear later (use
  // when subs run ahead of the audio). Stored in seconds.
  subsOffset: 0,
  // Audio chunk length in seconds. Smaller = subtitles arrive more often
  // (lower live latency) at a small accuracy cost near chunk boundaries.
  // Cost is unaffected (OpenAI bills per second of audio, not per request).
  chunkSeconds: 5,
};

export function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(Object.keys(DEFAULTS), (s) => {
      resolve({ ...DEFAULTS, ...s });
    });
  });
}

export function saveSettings(patch) {
  return new Promise((resolve) => {
    chrome.storage.local.set(patch, resolve);
  });
}
