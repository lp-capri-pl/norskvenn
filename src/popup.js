import { getSettings, saveSettings } from './lib/settings.js';

const form = document.getElementById('settings');
const status = document.getElementById('status');
const apiFieldset = document.getElementById('api-fieldset');
const offsetDisplay = document.getElementById('offset-display');

let subsOffset = 0;

function updateApiVisibility() {
  const engine = form.engine.value;
  apiFieldset.hidden = engine !== 'api';
}

function renderOffset() {
  const sign = subsOffset > 0 ? '+' : subsOffset < 0 ? '−' : '';
  offsetDisplay.textContent = `${sign}${Math.abs(subsOffset).toFixed(1)}s`;
  offsetDisplay.classList.toggle('zero', subsOffset === 0);
}

(async () => {
  const s = await getSettings();
  form.engine.value = s.engine;
  form.apiKey.value = s.apiKey;
  subsOffset = s.subsOffset || 0;
  renderOffset();
  updateApiVisibility();
})();

form.addEventListener('change', (e) => {
  if (e.target.name === 'engine') updateApiVisibility();
});

// Live-apply nudge buttons (no need to click Save for timing changes).
document.querySelectorAll('.nudge').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const delta = parseFloat(btn.dataset.delta);
    subsOffset = Math.round((subsOffset + delta) * 10) / 10;   // 1-decimal clamp
    subsOffset = Math.max(-3, Math.min(3, subsOffset));
    renderOffset();
    await saveSettings({ subsOffset });
  });
});

document.getElementById('offset-reset').addEventListener('click', async () => {
  subsOffset = 0;
  renderOffset();
  await saveSettings({ subsOffset });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const engine = form.engine.value;
  const apiKey = form.apiKey.value.trim();

  if (engine === 'api' && !apiKey) {
    status.textContent = 'Enter an API key first';
    status.className = 'status err';
    return;
  }

  await saveSettings({ engine, apiKey });
  status.textContent = '✓ Saved — reload your YouTube tab to apply';
  status.className = 'status ok';
  setTimeout(() => { status.textContent = ''; }, 4000);
});
