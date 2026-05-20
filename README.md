# Norskvenn

Chrome extension that overlays bilingual **Norwegian + English** subtitles on
any YouTube video, in real time, with Whisper running entirely in your
browser.

Built because most Norwegian YouTube content either has no captions at all,
or only auto-generated Norwegian ones — and language learners want English
alongside Norwegian to follow along.

## How it works

1. Open any YouTube watch page → a red **🇳🇴 Live subs** button appears next
   to Like / Share.
2. Click it. First run downloads `Xenova/nb-whisper-base-beta` (~210 MB)
   into your browser cache. This is the Norwegian-finetuned Whisper from
   the National Library of Norway — far more accurate on Norwegian than
   generic Whisper. Subsequent uses are instant.
3. The extension captures the player's audio via `HTMLVideoElement.captureStream()`,
   buckets it into 30-second chunks, and runs each chunk through Whisper twice
   inside an offscreen document — once in `transcribe` mode (Norwegian text)
   and once in `translate` mode (Whisper's native NO→EN translation, no extra
   translation API needed).
4. Bilingual cues appear overlaid on the player, synced to `currentTime`.
5. Results are cached in IndexedDB per videoId so revisiting a video is
   instant.

**No server. No accounts. No API keys.** Everything runs locally.

## Why this and not [Language Reactor / Trancy / etc.]

Those tools are great but rely on YouTube's *existing* captions. For Norwegian
content without captions they're useless. Norskvenn generates the
Norwegian transcript itself (Whisper) and translates it (Whisper) — so it
works on videos those tools can't touch.

## Install (for users — no build required)

1. Go to the [**Releases page**](../../releases) of this repo
2. Download `norskvenn-vX.Y.Z.zip` from the latest release
3. Unzip it anywhere — you'll get a folder called `dist/` (or rename it to `norskvenn`)
4. Open Chrome → `chrome://extensions/`
5. Toggle **Developer mode** on (top right)
6. Click **Load unpacked** → pick the unzipped folder
7. Open any youtube.com video → look for the red **🇳🇴 Live subs** button near Like / Share

> Chrome will warn "Disable developer mode extensions" once per restart while
> the extension is unpacked. Click "Keep" each time, or pin it for a smaller
> nag. This is normal — Chrome shows it for every extension installed outside
> the Web Store.

To update: download the new release zip, replace the old folder, hit the
🔄 reload icon on the extension card.

## Install (dev / build from source)

```bash
git clone <this-repo-url>
cd norskvenn
npm install
npm run build
# then "Load unpacked" → pick the dist/ folder
```

For iterating: `npm run dev` rebuilds on every save. Hit the **reload** icon
on the extension card in `chrome://extensions/` after each change.

## Performance notes

- Whisper `base` quantized to q8 runs at roughly real-time on a recent
  MacBook (M-series, recent Intel). Older hardware may lag behind the video
  — subtitles will still arrive, just a chunk or two behind playback.
- Bigger models (`Xenova/whisper-small`, ~240 MB) give noticeably better
  Norwegian. Change `MODEL_ID` in `src/content.js` to switch.
- First chunk after page load is the slowest — model has to warm up.

## File map

- `manifest.config.js` — Chrome MV3 manifest (built by @crxjs/vite-plugin)
- `src/background.js` — service worker, just routes messages and spawns the
  offscreen document
- `src/offscreen.html` + `src/offscreen.js` — persistent host for the Whisper
  pipeline (transformers.js + onnxruntime-web)
- `src/content.js` — UI injection, audio capture, cue rendering
- `src/content.css` — button + overlay styling
- `src/lib/audio.js` — `captureStream` → Web Audio → 16 kHz Float32 chunks
- `src/lib/cache.js` — IndexedDB subs cache per videoId
- `src/lib/srt.js` — bilingual SRT renderer (for an eventual "download" button)

## Status

v0.1 — initial scaffold. Works end-to-end but:
- No popup UI yet (model size / language hard-coded in content.js)
- No "download as .srt" button (renderer exists in `lib/srt.js`, just needs UI)
- No icons (Chrome shows a default puzzle piece)
- Real-time only — no "transcribe entire video offline" mode
