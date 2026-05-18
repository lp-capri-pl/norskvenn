import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from './manifest.config.js';

/**
 * Copy ORT runtime artifacts from @huggingface/transformers/dist/ into the
 * extension bundle so onnxruntime-web can load them locally instead of trying
 * to fetch them from jsDelivr at runtime (which Chrome extension CSP blocks).
 *
 * Pairs with `env.backends.onnx.wasm.wasmPaths` set in src/offscreen.js.
 */
function copyOrtAssets() {
  const files = [
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jsep.mjs',
  ];
  return {
    name: 'copy-ort-assets',
    apply: 'build',
    closeBundle() {
      const src = resolve(
        process.cwd(),
        'node_modules/@huggingface/transformers/dist',
      );
      const dst = resolve(process.cwd(), 'dist/ort');
      mkdirSync(dst, { recursive: true });
      for (const f of files) {
        copyFileSync(`${src}/${f}`, `${dst}/${f}`);
      }
      console.log(`[copy-ort-assets] copied ${files.length} files to dist/ort/`);
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), copyOrtAssets()],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Offscreen html is referenced from background.js via chrome.offscreen API,
      // not by an HTML script tag, so crxjs needs to be told about it.
      input: {
        offscreen: 'src/offscreen.html',
      },
    },
    target: 'esnext',
    chunkSizeWarningLimit: 4096,
  },
});
