/**
 * Read/write user-facing settings (engine + API key) via chrome.storage.local.
 * chrome.storage is per-extension, encrypted at rest, and survives reloads.
 */

const DEFAULTS = {
  engine: 'local',         // 'local' | 'api'
  apiKey: '',
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
