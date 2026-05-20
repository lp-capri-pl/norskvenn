import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Norskvenn — Norwegian YouTube subs',
  short_name: 'Norskvenn',
  version: '0.7.0',
  description:
    'Generate bilingual Norwegian + English subtitles for any YouTube video, all in your browser.',

  // No icons for v0.1 — Chrome will use a default. Add later.
  // icons: { '16': 'icons/16.png', '48': 'icons/48.png', '128': 'icons/128.png' },

  permissions: [
    'storage',       // user settings + cached subtitle results
    'offscreen',     // run Whisper in an offscreen document
    'activeTab',
  ],

  host_permissions: [
    'https://www.youtube.com/*',
    // transformers.js downloads model weights from huggingface.co
    'https://huggingface.co/*',
    'https://cdn-lfs.huggingface.co/*',
    // OpenAI Audio API (opt-in via popup settings)
    'https://api.openai.com/*',
  ],

  action: {
    default_title: 'Norskvenn settings',
    default_popup: 'src/popup.html',
  },

  // MV3's default CSP blocks WebAssembly.instantiate(). Without
  // 'wasm-unsafe-eval' the ORT WASM runtime in the offscreen doc throws
  // "neither 'wasm-eval' nor 'unsafe-eval' is an allowed source of script".
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },

  background: {
    service_worker: 'src/background.js',
    type: 'module',
  },

  content_scripts: [
    {
      matches: ['https://www.youtube.com/*'],
      js: ['src/content.js'],
      css: ['src/content.css'],
      run_at: 'document_idle',
    },
  ],

  web_accessible_resources: [
    {
      // 'ort/*' = locally-bundled onnxruntime-web WASM artifacts the offscreen
      //          document fetches at runtime (see vite.config.js copyOrtAssets).
      resources: ['src/offscreen.html', 'assets/*', 'ort/*'],
      matches: ['https://www.youtube.com/*'],
    },
  ],
});
