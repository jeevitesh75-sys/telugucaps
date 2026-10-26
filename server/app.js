"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { json, fail, readJson, sendFile, parseMultipart, Counter } = require("./util");
const { Jobs } = require("./jobs"), media = require("./media"), { STYLES } = require("./ass"), { MODES } = require("./captions");

const MB = 1048576;
// ---- PLANS: the single place to add a paid tier (e.g. look up a licence key / login here) ----
const PLANS = {
  free: { name: "free", maxSeconds: 180, maxBytes: 200 * MB, perDay: 3, watermark: true },
  paid: { name: "paid", maxSeconds: 900, maxBytes: 500 * MB, perDay: 100, watermark: false }
};
function planFor(req, env, plans = PLANS) { // later: check a paid key header/cookie here and return PLANS.paid
  const k = req.headers["x-paid-key"]; if (env.PAID_KEYS && k && env.PAID_KEYS.split(",").includes(k)) return plans.paid || PLANS.paid;
  return plans.free;
}

function createApp(cfg = {}) {
  const env = cfg.env || process.env;
  // Optional owner key. With USER_KEY_ONLY=1 the owner key is ignored and every visitor must bring their own Groq key.
  const key = env.USER_KEY_ONLY === "1" ? "" : (cfg.groqKey !== undefined ? cfg.groqKey : env.GROQ_API_KEY) || "";
  const KEY_RE = /^gsk_[A-Za-z0-9_-]{20,200}$/;
  const root = path.join(__dirname, "..");
  const dataDir = cfg.dataDir || path.join(os.tmpdir(), "telugucaps"), pub = path.join(root, "public");
  const fontsDir = fs.existsSync(path.join(root, "fonts")) && fs.readdirSync(path.join(root, "fonts")).length ? path.join(root, "fonts") : null;
  const jobs = new Jobs({ dir: dataDir, fetchFn: cfg.fetchFn || fetch, key: "", fontsDir, ttlMs: cfg.ttlMs || 3600e3, groqModel: env.GROQ_CHAT_MODEL, whisperModel: env.GROQ_WHISPER_MODEL });
  const apiHits = new Counter(), upHits = new Counter(), daily = new Counter();
  // Limits are OFF by default for now. To turn them back on set env FREE_PER_DAY=3, FREE_MAX_SECONDS=180, WATERMARK=1
  const plans = cfg.plans || { ...PLANS, free: { ...PLANS.free, perDay: +env.FREE_PER_DAY || 0, maxSeconds: +env.FREE_MAX_SECONDS || 600, watermark: env.WATERMARK === "1" } };
  const limits = cfg.limits || {};
  const ip = req => String((env.TRUST_PROXY !== "0" && req.headers["x-forwarded-for"]) || req.socket.remoteAddress || "?").split(",")[0].trim();
  const visitor = req => { const m = /(?:^|; )tc=([a-f0-9]{16})/.exec(req.headers.cookie || ""); return m ? m[1] : null; };

  async function handler(req, res) {
    try {
      const u = new URL(req.url, "http://x"), p = u.pathname, who = ip(req);
      if (p.startsWith("/api/")) {
        if (apiHits.hit(who, 60e3) > (limits.api || 240)) throw fail(429, "Too many requests. Please wait a minute.");
        return await api(req, res, u, p, who);
      }
      let f = p === "/" ? "/index.html" : p; f = path.normalize(f).replace(/^(\.\.[/\\])+/, "");
      const full = path.join(pub, f); if (!full.startsWith(pub)) throw fail(404, "Not found");
      return sendFile(req, res, full);
    } catch (e) { json(res, e.code && e.code < 600 ? e.code : 500, { error: e.code ? e.message : "Something went wrong on the server. Please try again." }); if (!e.code) console.error(e); }
  }

  async function api(req, res, u, p, who) {
    const plan = planFor(req, env, plans), m = req.method;
    if (p === "/api/config" && m === "GET") return json(res, 200, { ready: true, needKey: !key, plan: plan.name, maxSeconds: plan.maxSeconds, maxMB: plan.maxBytes / MB, perDay: plan.perDay, watermark: plan.watermark,
      styles: Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, { name: s.name, font: s.font, bold: !!s.bold, color: s.color, hi: s.hi, upper: !!s.upper, scale: s.scale || 1 }])), perLine: Object.keys(MODES) });
    if (p === "/api/jobs" && m === "POST") {
      if (upHits.hit(who, 3600e3) > (limits.uploads || 20)) throw fail(429, "Too many uploads from your network. Try again later.");
      let vid = visitor(req), setCookie = null; if (!vid) { vid = require("crypto").randomBytes(8).toString("hex"); setCookie = `tc=${vid}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`; }
      const used = Math.max(daily.count("v:" + vid, 864e5), daily.count("i:" + who, 864e5) - 2);   // cookie is the main key; IP is a looser backstop (shared networks)
      if (plan.perDay && used >= plan.perDay) throw fail(429, `Free limit reached: ${plan.perDay} videos per day. Come back tomorrow.`);
      const j = jobs.create(vid, plan); let fields, file;
      try {
        ({ fields, file } = await parseMultipart(req, { maxFileBytes: plan.maxBytes, sink: name => { let ext = path.extname(name).toLowerCase(); if (!ext) ext = ".mp4"; if (![".mp4", ".mov", ".m4v", ".3gp", ".webm", ".mkv"].includes(ext)) throw fail(400, "Please upload an MP4 or MOV video."); const pth = path.join(j.dir, "input" + ext); return { stream: fs.createWriteStream(pth), path: pth }; } }));
        if (!file || !file.size) throw fail(400, "No video was uploaded.");
        // Each visitor uses their own Groq key (sent with the upload, kept in memory only, deleted when the job ends)
        const userKey = String(fields.groqKey || "").trim();
        if (userKey && !KEY_RE.test(userKey)) throw fail(400, "That does not look like a Groq key. It starts with gsk_ . Copy it again from console.groq.com.");
        if (!userKey && !key) throw fail(400, "Paste your free Groq key first (get it at console.groq.com).");
        j.key = userKey || key;
        const info = await media.probe(file.path).catch(() => null);
        if (!info) throw fail(400, "This file is not a readable video.");
        if (!info.audio) throw fail(400, "This video has no sound, so there is nothing to caption.");
        if (info.duration > plan.maxSeconds + 1) throw fail(400, `This video is ${Math.round(info.duration)} seconds. The limit is ${plan.maxSeconds / 60} minutes.`);
        j.video = file.path; j.info = info;
        const opts = { spelling: fields.spelling === "sms" ? "sms" : "simple", mixed: fields.mixed !== "0", perLine: MODES[fields.perLine] ? fields.perLine : "w3" };
        daily.hit("v:" + vid, 864e5); daily.hit("i:" + who, 864e5);
        jobs.analyze(j, opts);
      } catch (e) { fs.rmSync(j.dir, { recursive: true, force: true }); jobs.map.delete(j.id); throw e; }
      if (setCookie) res.setHeader("Set-Cookie", setCookie);
      return json(res, 200, { id: j.id });
    }
    const mm = /^\/api\/jobs\/([a-f0-9]+)(?:\/(\w+))?$/.exec(p); if (!mm) throw fail(404, "Not found");
    const j = jobs.get(mm[1]); if (!j) throw fail(404, "This video was deleted (videos are kept for 1 hour). Please upload it again.");
    const act = mm[2];
    if (!act && m === "GET") { const v = jobs.view(j); v.queue = jobs.position(j); return json(res, 200, v); }
    if (act === "captions" && m === "PUT") {
      if (j.status !== "review" && j.status !== "done") throw fail(409, "Captions are not ready yet.");
      const b = await readJson(req), arr = Array.isArray(b.lines) ? b.lines : null; if (!arr || arr.length > 5000) throw fail(400, "Bad captions");
      j.lines = arr.map((l, i) => { const old = j.lines[l.id] || {}; return { id: i, start: Math.max(0, +l.start || 0), end: Math.max(+l.start || 0, +l.end || 0) || (+l.start + 1), text: String(l.text || "").replace(/[\r\n]+/g, " ").slice(0, 200), words: old.words, low: !!old.low && l.text === old.text, deleted: !!l.deleted }; });
      return json(res, 200, { ok: true });
    }
    if (act === "render" && m === "POST") {
      if (j.status !== "review" && j.status !== "done") throw fail(409, "Check the captions first.");
      const b = await readJson(req); const s = b.style || {};
      jobs.render(j, { style: STYLES[s.style] ? s.style : "classic", size: +s.size || 1, color: s.color, highlight: s.highlight, position: ["top", "middle", "bottom"].includes(s.position) ? s.position : "bottom" });
      return json(res, 200, { ok: true });
    }
    if (act === "download" && m === "GET") { if (j.status !== "done") throw fail(409, "The video is not ready yet."); return sendFile(req, res, j.out, { download: "telugucaps.mp4", type: "video/mp4" }); }
    if (act === "preview" && m === "GET") { if (j.status !== "done") throw fail(409, "The video is not ready yet."); return sendFile(req, res, j.out, { type: "video/mp4" }); }
    if (act === "frame" && m === "GET") { if (!j.video) throw fail(404, "No video"); const f = path.join(j.dir, "frame.jpg"); if (!fs.existsSync(f)) await media.frameAt(j.video, Math.min(1, j.info.duration / 2), f); return sendFile(req, res, f, { type: "image/jpeg" }); }
    if (act === "source" && m === "GET") { if (!j.video) throw fail(404, "No video"); return sendFile(req, res, j.video, { type: "video/mp4" }); }
    throw fail(404, "Not found");
  }

  const server = http.createServer(handler); server.requestTimeout = 0; server.headersTimeout = 60e3;
  jobs.startSweeper(); const t = setInterval(() => { apiHits.sweep(60e3); upHits.sweep(3600e3); daily.sweep(864e5); }, 600e3); t.unref();
  server.on("close", () => { clearInterval(jobs.timer); clearInterval(t); });
  return { server, jobs, handler };
}
module.exports = { createApp, PLANS, planFor };
