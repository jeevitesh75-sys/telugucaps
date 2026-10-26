"use strict";
// words:[{t (telugu), r (english letters), s, e, seg}]  ->  lines
const MODES = { w3: 3, w6: 6, full: 14 };

function groupLines(words, mode = "w3", segLow = []) {
  const max = MODES[mode] || 3, lines = []; let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const s = cur[0].s, e = Math.max(cur[cur.length - 1].e, s + 0.35);
    lines.push({ id: lines.length, start: s, end: e, text: cur.map(w => w.r).join(" "), words: cur.map(w => ({ r: w.r, s: w.s, e: w.e })), low: cur.some(w => segLow[w.seg]) });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = cur[cur.length - 1];
    if (prev && (w.seg !== prev.seg && mode !== "full" || w.s - prev.e > 0.9 || cur.length >= max || (mode === "full" && w.seg !== prev.seg))) flush();
    cur.push(w);
  }
  flush();
  for (let i = 0; i < lines.length; i++) {     // hold each caption a little, but never into the next one
    const next = lines[i + 1], want = lines[i].end + 0.25;
    lines[i].end = next ? Math.min(want, Math.max(lines[i].end, next.start)) : want;
  }
  return lines;
}

// Words (with times) of a possibly edited line. Same word count -> keep Whisper's times, otherwise spread by letters.
function lineWords(line) {
  const toks = String(line.text || "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  if (line.words && line.words.length === toks.length) return toks.map((r, i) => ({ r, s: line.words[i].s, e: line.words[i].e }));
  const s = line.start, e = line.end, total = toks.reduce((a, t) => a + t.length + 1, 0); let at = s;
  return toks.map(r => { const d = (e - s) * (r.length + 1) / total, w = { r, s: at, e: at + d }; at += d; return w; });
}

const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, "0")}`; };
module.exports = { groupLines, lineWords, fmt, MODES };
