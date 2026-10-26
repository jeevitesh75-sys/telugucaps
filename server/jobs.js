"use strict";
const fs = require("fs"), path = require("path");
const { rid } = require("./util");
const media = require("./media"), groq = require("./groq"), { groupLines } = require("./captions"), { buildAss } = require("./ass");

class Jobs {
  constructor({ dir, fetchFn, key, ttlMs = 3600e3, fontsDir, groqModel, whisperModel }) {
    Object.assign(this, { dir, fetchFn, key, ttlMs, fontsDir, groqModel, whisperModel }); this.map = new Map(); this.queue = []; this.busy = false;
    fs.mkdirSync(dir, { recursive: true });
  }
  create(owner, plan) { const id = rid(10), d = path.join(this.dir, id); fs.mkdirSync(d, { recursive: true });
    const j = { id, dir: d, owner, plan, status: "uploading", progress: 0, created: Date.now(), error: null }; this.map.set(id, j); return j; }
  get(id) { return this.map.get(id); }
  view(j) { return { id: j.id, status: j.status, progress: +j.progress.toFixed(3), error: j.error, info: j.info, lines: j.status === "review" || j.status === "done" || j.status === "rendering" ? j.lines : undefined, quality: j.quality, plan: j.plan, expiresAt: j.created + this.ttlMs, fallbacks: j.fallbacks }; }
  enqueue(j, fn, cleanup) { this.queue.push({ j, fn, cleanup }); this._next(); }
  async _next() {
    if (this.busy) return; const t = this.queue.shift(); if (!t) return; this.busy = true;
    try { await t.fn(); } catch (e) { t.j.status = "error"; t.j.error = e.message || "Something went wrong"; console.error("job", t.j.id, e.message); }
    if (t.cleanup) try { t.cleanup(); } catch {}
    this.busy = false; setImmediate(() => this._next());
  }
  position(j) { return this.queue.findIndex(t => t.j === j) + 1; }

  // upload done -> transcribe -> romanize -> lines for review
  analyze(j, opts) {
    j.opts = opts; j.status = "queued"; j.progress = 0;
    this.enqueue(j, async () => {
      j.status = "extracting"; j.progress = 0.05;
      const parts = await media.extractAudio(j.video, j.dir, j.info.duration);
      j.status = "transcribing"; const words = [], segLow = []; let segBase = 0;
      for (let i = 0; i < parts.length; i++) {
        const r = await groq.transcribe({ fetchFn: this.fetchFn, key: j.key, wavPath: parts[i].path, model: this.whisperModel });
        const off = parts[i].offset;
        // assign each word to a segment (by start time)
        r.segments.forEach(sg => segLow[segBase + r.segments.indexOf(sg)] = sg.low);
        for (const w of r.words) {
          let si = r.segments.findIndex(sg => w.s >= sg.s - 0.05 && w.s < sg.e + 0.05); if (si < 0) si = r.segments.length ? r.segments.length - 1 : 0;
          words.push({ t: w.w, s: w.s + off, e: w.e + off, seg: segBase + si });
        }
        segBase += Math.max(1, r.segments.length); j.progress = 0.1 + 0.4 * (i + 1) / parts.length;
      }
      if (!words.length) throw new Error("No speech was found in this video. Check that the speaker's voice is clear.");
      j.status = "romanizing";
      const rom = await groq.romanize({ fetchFn: this.fetchFn, key: j.key, words: words.map(w => w.t), style: opts.spelling, mixed: opts.mixed, model: this.groqModel, onProgress: p => j.progress = 0.5 + 0.45 * p });
      j.fallbacks = rom.fallbacks;
      words.forEach((w, i) => w.r = rom.out[i] || w.t);
      j.lines = groupLines(words, opts.perLine, segLow); j.words = words;
      j.status = "review"; j.progress = 1;
    }, () => { delete j.key; });   // the visitor's Groq key is never kept after the job ends (success or failure)
  }

  render(j, style) {
    j.status = "queued"; j.progress = 0; j.quality = null;
    this.enqueue(j, async () => {
      j.status = "rendering";
      const assPath = path.join(j.dir, "captions.ass"), out = path.join(j.dir, "out.mp4");
      fs.writeFileSync(assPath, buildAss(j.lines, j.info, { ...style, watermark: j.plan.watermark ? "Made with TeluguCaps" : null }));
      await media.render({ input: j.video, output: out, ass: assPath, fontsDir: this.fontsDir, audioCodec: j.info.audio, duration: j.info.duration, onProgress: p => j.progress = p });
      j.quality = await media.verify(j.video, out, j.info); j.out = out; j.status = "done"; j.progress = 1;
    });
  }

  sweep() { const now = Date.now(); for (const [id, j] of this.map) if (now - j.created > this.ttlMs && !["rendering", "extracting", "transcribing", "romanizing"].includes(j.status)) { fs.rmSync(j.dir, { recursive: true, force: true }); this.map.delete(id); }
    try { for (const n of fs.readdirSync(this.dir)) { const p = path.join(this.dir, n); if (!this.map.has(n) && now - fs.statSync(p).mtimeMs > this.ttlMs) fs.rmSync(p, { recursive: true, force: true }); } } catch {} }
  startSweeper() { this.timer = setInterval(() => this.sweep(), 60e3); this.timer.unref(); }
}
module.exports = { Jobs };
