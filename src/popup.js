import { getSettings, saveSettings } from './lib/settings.js';

const form = document.getElementById('settings');
const status = document.getElementById('status');
const apiFieldset = document.getElementById('api-fieldset');

function updateApiVisibility() {
  const engine = form.engine.value;
  apiFieldset.hidden = engine !== 'api';
}

(async () => {
  const s = await getSettings();
  form.engine.value = s.engine;
  form.apiKey.value = s.apiKey;
  updateApiVisibility();
})();

form.addEventListener('change', (e) => {
  if (e.target.name === 'engine') updateApiVisibility();
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
