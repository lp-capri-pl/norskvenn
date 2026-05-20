/**
 * OpenAI Audio API client.
 *
 * Endpoints:
 *   /v1/audio/transcriptions — speech-to-text in source language
 *   /v1/audio/translations   — speech-to-English translation
 *
 * Model choice: we hard-code `whisper-1` because it's the only audio model
 * that returns per-segment timestamps (via response_format=verbose_json),
 * which we need to sync subs against video.currentTime. The newer
 * gpt-4o-(mini-)transcribe are higher-quality but return only flat text.
 */
import { encodeWav } from './wav.js';

const ENDPOINTS = {
  transcribe: 'https://api.openai.com/v1/audio/transcriptions',
  translate:  'https://api.openai.com/v1/audio/translations',
};

export async function transcribeViaApi({ apiKey, samples, task, language }) {
  if (!apiKey) throw new Error('No OpenAI API key set — open the extension popup to add one.');

  const wav = encodeWav(samples);
  const form = new FormData();
  form.append('file', wav, 'chunk.wav');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  // language only applies to transcribe; translations always output English
  if (task === 'transcribe' && language) form.append('language', language);

  const resp = await fetch(ENDPOINTS[task] || ENDPOINTS.transcribe, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    let msg = `OpenAI ${resp.status}`;
    try {
      const j = JSON.parse(errText);
      msg += `: ${j.error?.message || errText.slice(0, 200)}`;
    } catch {
      msg += `: ${errText.slice(0, 200)}`;
    }
    throw new Error(msg);
  }

  const json = await resp.json();
  const segs = Array.isArray(json.segments) ? json.segments : [];

  // Self-check: drop segments Whisper itself flags as low-confidence or
  // non-speech. These are the same thresholds OpenAI's reference Whisper
  // uses to detect hallucination/garbage:
  //   no_speech_prob high + avg_logprob low  → music/silence misheard as speech
  //   avg_logprob < -1.0                     → model is guessing
  //   compression_ratio > 2.4                → repetitive hallucination loop
  let dropped = 0;
  const keep = segs.filter((s) => {
    const noSpeech = (s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.5;
    const lowConf = (s.avg_logprob ?? 0) < -1.0;
    const repetitive = (s.compression_ratio ?? 0) > 2.4;
    if (noSpeech || lowConf || repetitive) {
      dropped++;
      return false;
    }
    return true;
  });
  if (dropped) {
    console.log(`[openai] self-check dropped ${dropped}/${segs.length} low-confidence segment(s)`);
  }

  const parsed = keep
    .map((s) => ({
      start: s.start ?? 0,
      end: s.end ?? s.start ?? 0,
      text: (s.text || '').trim(),
    }))
    .filter((s) => s.text);

  if (parsed.length) return parsed;

  // Only fall back to the flat text when the API returned NO segments at all.
  // If it returned segments but the self-check dropped them all, the text is
  // the same low-quality output — return nothing rather than show garbage.
  if (segs.length === 0) {
    const fullText = (json.text || '').trim();
    if (fullText) {
      return [{ start: 0, end: json.duration || samples.length / 16000, text: fullText }];
    }
  }
  return [];
}
