"use strict";
const fs = require("fs");
const { translit, isTelugu } = require("./translit");
const BASE = "https://api.groq.com/openai/v1";

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e; if (!e.retryable || i === tries - 1) break;
      await new Promise(r => setTimeout(r, e.waitMs || 1500 * (i + 1)));
    }
  }
  throw last;
}
function httpError(status, text, headers) {
  let msg = text; try { msg = JSON.parse(text).error.message; } catch {}
  const e = new Error(status === 401 ? "The Groq API key is wrong or missing." : status === 429 ? "Groq is busy or the free limit is reached. Try again in a few minutes." : "Groq error: " + String(msg).slice(0, 160));
  e.retryable = status === 429 || status >= 500;
  const ra = headers && headers.get && Number(headers.get("retry-after")); if (ra) e.waitMs = Math.min(ra, 20) * 1000;
  return e;
}

// wavPath -> { words:[{w,s,e}], segments:[{s,e,text,low}] }  (times in seconds from the start of THIS file)
async function transcribe({ fetchFn, key, wavPath, model = "whisper-large-v3" }) {
  return withRetry(async () => {
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(wavPath)], { type: "audio/wav" }), "audio.wav");
    fd.append("model", model); fd.append("language", "te"); fd.append("response_format", "verbose_json"); fd.append("temperature", "0");
    fd.append("timestamp_granularities[]", "word"); fd.append("timestamp_granularities[]", "segment");
    const r = await fetchFn(BASE + "/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
    const t = await r.text(); if (!r.ok) throw httpError(r.status, t, r.headers);
    const j = JSON.parse(t);
    const segments = (j.segments || []).map(s => ({ s: +s.start, e: +s.end, text: String(s.text || "").trim(), low: (s.avg_logprob !== undefined && s.avg_logprob < -0.85) || (s.no_speech_prob !== undefined && s.no_speech_prob > 0.6) || (s.compression_ratio !== undefined && s.compression_ratio > 2.4) }));
    let words = (j.words || []).map(w => ({ w: String(w.word || "").trim(), s: +w.start, e: +w.end })).filter(w => w.w);
    if (!words.length) {   // no word times returned: spread each segment's words evenly
      for (const sg of segments) { const ws = sg.text.split(/\s+/).filter(Boolean); ws.forEach((w, i) => words.push({ w, s: sg.s + (sg.e - sg.s) * i / ws.length, e: sg.s + (sg.e - sg.s) * (i + 1) / ws.length })); }
    }
    return { words, segments };
  });
}

const SYS = `You write Telugu speech in ENGLISH LETTERS (transliteration). This is NOT translation.
Rules:
- Same words, same order, same count. Never translate, never add or remove words.
- Spell the way a Telugu youth types on WhatsApp: simple, easy to read, lowercase. Example: నేను రేపు వస్తాను -> nenu repu vastanu.
- No Telugu script, no punctuation, no diacritics in the output.
- If a word is an English word (written in Telugu script or in English), write it in normal English spelling, for example ఫోన్ -> phone, వీడియో -> video.
- Output strict JSON only: {"out":["...", "..."]} with exactly as many items as the input words, in the same order.`;

async function chatBatch({ fetchFn, key, model, words, style, mixed }) {
  const user = JSON.stringify({ spelling: style === "sms" ? "natural SMS style, very short, how people really type (em, ela, chesthunnav, ledu)" : "simple clear spelling", mixed_telugu_english: !!mixed, words });
  return withRetry(async () => {
    const body = { model, temperature: 0.1, max_tokens: 4000, response_format: { type: "json_object" }, messages: [{ role: "system", content: SYS }, { role: "user", content: user }] };
    if (/gpt-oss/.test(model)) body.reasoning_effort = "low";
    const r = await fetchFn(BASE + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const t = await r.text(); if (!r.ok) throw httpError(r.status, t, r.headers);
    const txt = JSON.parse(t).choices[0].message.content || "";
    let obj; try { obj = JSON.parse(txt); } catch { const m = /\{[\s\S]*\}/.exec(txt); obj = m ? JSON.parse(m[0]) : null; }
    return obj && Array.isArray(obj.out) ? obj.out : null;
  });
}

const clean = s => String(s || "").normalize("NFC").replace(/[^\p{L}\p{N}'’ -]/gu, "").trim();
const okLatin = s => s && !isTelugu(s) && /[A-Za-z0-9]/.test(s);

// words: Telugu-script strings -> Latin strings (same length). Falls back to the offline table per word when needed.
async function romanize({ fetchFn, key, words, style = "simple", mixed = true, model = "openai/gpt-oss-120b", batch = 60, onProgress }) {
  const out = new Array(words.length); let fallbacks = 0;
  const fill = async (from, to, size) => {
    const part = words.slice(from, to); let got = null;
    try { got = await chatBatch({ fetchFn, key, model, words: part, style, mixed }); } catch (e) { if (e.message.includes("key") || e.message.includes("busy")) throw e; }
    if (got && got.length === part.length && got.every(x => okLatin(clean(x)))) { got.forEach((x, i) => out[from + i] = clean(x).toLowerCase() === clean(x) ? clean(x) : clean(x)); return; }
    if (part.length > 6) { const mid = from + Math.ceil(part.length / 2); await fill(from, mid); await fill(mid, to); return; }   // retry smaller
    part.forEach((w, i) => { out[from + i] = okLatin(w) ? clean(w) : translit(w); fallbacks++; });
  };
  for (let i = 0; i < words.length; i += batch) { await fill(i, Math.min(words.length, i + batch)); if (onProgress) onProgress(Math.min(1, (i + batch) / words.length)); }
  return { out, fallbacks };
}

module.exports = { transcribe, romanize, clean };
