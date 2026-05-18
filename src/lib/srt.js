/** Render bilingual (Norwegian + English) subtitles as a downloadable .srt. */

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function fmtTs(seconds) {
  if (seconds < 0 || !Number.isFinite(seconds)) seconds = 0;
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/**
 * Pair NO + EN segments by max time overlap and emit one SRT cue per NO
 * segment, with the EN translation as a second line.
 */
export function bilingualSrt(noSegs, enSegs) {
  const lines = [];
  noSegs.forEach((no, i) => {
    const en = pickClosest(no, enSegs);
    lines.push(String(i + 1));
    lines.push(`${fmtTs(no.start)} --> ${fmtTs(no.end)}`);
    lines.push(no.text);
    if (en?.text) lines.push(en.text);
    lines.push('');
  });
  return lines.join('\n');
}

function pickClosest(no, enSegs) {
  if (!enSegs?.length) return null;
  const noMid = (no.start + no.end) / 2;
  let best = null, bestDist = Infinity;
  for (const en of enSegs) {
    const overlap = en.end >= no.start && en.start <= no.end;
    const d = overlap ? 0 : Math.abs((en.start + en.end) / 2 - noMid);
    if (d < bestDist) { bestDist = d; best = en; }
  }
  return best;
}
