/**
 * Capture a YouTube <video> element's audio as 16-kHz mono Float32 chunks.
 *
 * We use HTMLVideoElement.captureStream() — this hands back a MediaStream
 * carrying whatever the element is currently playing. The user does NOT need
 * to keep the video unmuted or unminimized; captureStream works regardless of
 * the element's mute state.
 *
 * We funnel that into Web Audio, downsample to 16 kHz mono (Whisper's
 * required input rate), and bucket samples into fixed-length chunks. A
 * caller-provided `onChunk(samples, startSeconds)` fires once per bucket.
 */

const SAMPLE_RATE = 16000;
// Whisper was trained on 30 s windows but the pipeline pads shorter inputs
// automatically. Smaller chunks = first sub appears 3x sooner with similar
// per-chunk inference cost.
const CHUNK_SECONDS = 10;
const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_SECONDS;

export class AudioCapturer {
  constructor(videoEl, { onChunk } = {}) {
    this.videoEl = videoEl;
    this.onChunk = onChunk;

    this.audioCtx = null;
    this.source = null;
    this.processor = null;
    this.stream = null;

    this.buffer = new Float32Array(CHUNK_SAMPLES);
    this.bufferOffset = 0;
    this.running = false;

    // Sample-accurate timing. Rather than read video.currentTime at each
    // emit (which jitters because the JS callback fires at an unpredictable
    // moment after the audio was actually captured), we anchor to the video
    // time when capture started and advance by the exact number of samples
    // emitted. Audio is continuous, so sample count → time is drift-free.
    this._anchorVideoTime = 0;     // video time at capture start / last seek
    this._emittedSamples = 0;      // total samples emitted since the anchor

    // Seek handler: discard the partial buffer AND re-anchor, because after a
    // seek the sample stream corresponds to a new video position.
    this._onSeeked = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;

    // captureStream is available on HTMLVideoElement in all Chromium.
    if (typeof this.videoEl.captureStream !== 'function') {
      throw new Error('video.captureStream() unavailable — needs Chrome 73+');
    }
    this.stream = this.videoEl.captureStream();

    const audioTracks = this.stream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('Video element has no audio track yet — start playback first');
    }

    // Build an audio graph at 16 kHz so the browser handles the resampling
    // for us. AudioContext supports custom sampleRate since Chrome 53.
    this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.source = this.audioCtx.createMediaStreamSource(
      new MediaStream([audioTracks[0]]),
    );

    // ScriptProcessorNode is deprecated but still the simplest way to pull
    // PCM samples synchronously. AudioWorklet would be cleaner but requires
    // a separate worklet module file — overkill for v0.1.
    const bufferSize = 4096;
    this.processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
    this.processor.onaudioprocess = (e) => this._onAudio(e);

    this.source.connect(this.processor);
    // ScriptProcessor only fires onaudioprocess if it's connected to the
    // destination. Route to a muted gain so we don't echo audio.
    const sink = this.audioCtx.createGain();
    sink.gain.value = 0;
    this.processor.connect(sink);
    sink.connect(this.audioCtx.destination);

    this._anchorVideoTime = this.videoEl.currentTime;
    this._emittedSamples = 0;

    // Drop any partial buffer when the user seeks AND re-anchor timing —
    // otherwise a chunk would splice together pre/post-seek audio AND the
    // sample counter would map to the wrong video position.
    this._onSeeked = () => {
      if (!this.running) return;
      console.log(`[audio] seeked to ${this.videoEl.currentTime.toFixed(1)}s — re-anchoring`);
      this.bufferOffset = 0;
      this._anchorVideoTime = this.videoEl.currentTime;
      this._emittedSamples = 0;
    };
    this.videoEl.addEventListener('seeked', this._onSeeked);
  }

  _onAudio(e) {
    if (!this.running) return;
    const input = e.inputBuffer.getChannelData(0);   // mono
    const n = input.length;

    if (this.bufferOffset + n <= CHUNK_SAMPLES) {
      this.buffer.set(input, this.bufferOffset);
      this.bufferOffset += n;
    } else {
      // Fill the rest of the current chunk, ship it, then start a new chunk
      // with the leftover samples.
      const room = CHUNK_SAMPLES - this.bufferOffset;
      this.buffer.set(input.subarray(0, room), this.bufferOffset);
      this._emit();
      const leftover = input.subarray(room);
      this.buffer.set(leftover, 0);
      this.bufferOffset = leftover.length;
    }

    if (this.bufferOffset >= CHUNK_SAMPLES) {
      this._emit();
    }
  }

  _emit() {
    // Copy because we're about to refill `this.buffer`.
    const chunk = new Float32Array(this.buffer);
    // Sample-accurate start time: anchor + duration of all audio emitted so
    // far. Drift-free because it doesn't depend on when the JS callback fires.
    const startTime = this._anchorVideoTime + this._emittedSamples / SAMPLE_RATE;
    this._emittedSamples += chunk.length;
    this.bufferOffset = 0;

    // Diagnostic: amplitude check. If max < 0.001 the captured stream is
    // silent (CORS-tainted media is the usual cause on YouTube) even though
    // an audio track exists. If max is healthy (>0.05) but Whisper still
    // returns nothing, the problem is the model.
    let max = 0, sumSq = 0;
    for (let i = 0; i < chunk.length; i++) {
      const a = Math.abs(chunk[i]);
      if (a > max) max = a;
      sumSq += chunk[i] * chunk[i];
    }
    const rms = Math.sqrt(sumSq / chunk.length);
    console.log(
      `[audio] chunk t=${startTime.toFixed(1)}s samples=${chunk.length} ` +
      `max=${max.toFixed(4)} rms=${rms.toFixed(5)} ` +
      `${max < 0.001 ? '⚠️ SILENT — capture broken' : '✓ has audio'}`,
    );

    if (this.onChunk) this.onChunk(chunk, startTime);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._onSeeked) {
      try { this.videoEl.removeEventListener('seeked', this._onSeeked); } catch {}
      this._onSeeked = null;
    }
    try { this.processor?.disconnect(); } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.audioCtx?.close(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    // Flush any partial buffer as a short final chunk.
    if (this.bufferOffset > SAMPLE_RATE) {  // >1s of audio
      const chunk = this.buffer.slice(0, this.bufferOffset);
      const startTime = this._anchorVideoTime + this._emittedSamples / SAMPLE_RATE;
      this._emittedSamples += chunk.length;
      if (this.onChunk) this.onChunk(chunk, startTime);
    }
    this.bufferOffset = 0;
  }
}
