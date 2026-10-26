"use strict";
const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const { createApp } = require("../server/app"), media = require("../server/media");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-test-"));
const sample = path.join(tmp, "sample.mp4");
// 5-second 360x640 portrait, 30 fps video with a tone, AAC audio
const mk = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=5", "-f", "lavfi", "-i", "sine=f=440:d=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sample]);
const TELUGU = ["నేను", "రేపు", "వస్తాను", "ఫోన్", "చేస్తాను"];

function mockFetch(calls) {
  return async (url, init) => {
    calls.push(String(url));
    if (/audio\/transcriptions/.test(url)) {
      const body = JSON.stringify({ text: TELUGU.join(" "),
        segments: [{ start: 0.2, end: 2.2, text: TELUGU.slice(0, 3).join(" "), avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.1 }, { start: 2.6, end: 4.4, text: "ఫోన్ చేస్తాను", avg_logprob: -1.4, no_speech_prob: 0.1, compression_ratio: 1.2 }],
        words: TELUGU.map((w, i) => ({ word: w, start: 0.2 + i * 0.9, end: 0.2 + i * 0.9 + 0.7 })) });
      return new Response(body, { status: 200 });
    }
    if (/chat\/completions/.test(url)) {
      const req = JSON.parse(init.body), user = JSON.parse(req.messages[1].content), map = { "నేను": "nenu", "రేపు": "repu", "వస్తాను": "vastanu", "ఫోన్": "phone", "చేస్తాను": "chestanu" };
      assert.equal(req.model, "openai/gpt-oss-120b"); assert.ok(req.temperature <= 0.2); assert.equal(req.response_format.type, "json_object");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ out: user.words.map(w => map[w]) }) } }] }), { status: 200 });
    }
    return new Response("no", { status: 404 });
  };
}
async function upload(base, file, fields = {}, headers = {}) {
  const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("video", new Blob([fs.readFileSync(file)], { type: "video/mp4" }), path.basename(file));
  return fetch(base + "/api/jobs", { method: "POST", body: fd, headers });
}
const wait = async (base, id, want, ms = 120000) => { const t0 = Date.now(); for (;;) { const j = await (await fetch(`${base}/api/jobs/${id}`)).json(); if (j.status === want || j.status === "error") return j; if (Date.now() - t0 > ms) throw new Error("timeout " + j.status); await new Promise(r => setTimeout(r, 200)); } };

test("sample 5-second video end to end (mock Groq, real ffmpeg)", async t => {
  assert.equal(mk.status, 0, String(mk.stderr));
  const calls = [], { server } = createApp({ groqKey: "test", dataDir: path.join(tmp, "data"), fetchFn: mockFetch(calls), env: {} });
  await new Promise(r => server.listen(0, r)); const base = "http://127.0.0.1:" + server.address().port; t.after(() => server.close());

  const cfg = await (await fetch(base + "/api/config")).json(); assert.equal(cfg.ready, true); assert.equal(Object.keys(cfg.styles).length, 8);

  const r = await upload(base, sample, { spelling: "simple", mixed: "1", perLine: "w3" }); assert.equal(r.status, 200); const { id } = await r.json();
  const rev = await wait(base, id, "review"); assert.equal(rev.status, "review", rev.error);
  assert.deepEqual(rev.lines.map(l => l.text), ["nenu repu vastanu", "phone chestanu"]);
  assert.equal(rev.lines[1].low, true, "low-confidence segment is flagged"); assert.equal(rev.lines[0].low, false);
  assert.ok(rev.lines[0].start >= 0.19 && rev.lines[0].start < 0.25);
  assert.ok(calls.some(c => /transcriptions/.test(c)) && calls.some(c => /chat\/completions/.test(c)));

  // user edits a spelling, then renders
  rev.lines[1].text = "phone chestanu ra";
  assert.equal((await fetch(`${base}/api/jobs/${id}/captions`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines: rev.lines }) })).status, 200);
  assert.equal((await fetch(`${base}/api/jobs/${id}/render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style: { style: "karaoke", position: "middle" } }) })).status, 200);
  const done = await wait(base, id, "done"); assert.equal(done.status, "done", done.error);
  assert.equal(done.quality.sameSize, true); assert.equal(done.quality.sameFps, true); assert.equal(done.quality.audioSame, true);
  assert.match(done.quality.text, /^Quality kept: 360x640, 30 fps, audio unchanged$/);

  const out = path.join(tmp, "dl.mp4"); const dl = await fetch(`${base}/api/jobs/${id}/download`); assert.equal(dl.status, 200); fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
  const a = await media.probe(sample), b = await media.probe(out);
  assert.equal(b.width, a.width); assert.equal(b.height, a.height); assert.equal(b.fps, a.fps); assert.ok(Math.abs(b.duration - a.duration) < 0.2);
  assert.equal(await media.audioMd5(sample), await media.audioMd5(out), "audio is bit-identical");
  // the captions are really burned in: a frame at 1 s differs from the plain input frame
  const f1 = path.join(tmp, "f1.png"), f2 = path.join(tmp, "f2.png");
  for (const [f, o] of [[sample, f1], [out, f2]]) spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "1", "-i", f, "-frames:v", "1", o]);
  assert.notDeepEqual(fs.readFileSync(f1), fs.readFileSync(f2));
  // range requests work for the player
  const rg = await fetch(`${base}/api/jobs/${id}/preview`, { headers: { Range: "bytes=0-99" } }); assert.equal(rg.status, 206); assert.equal((await rg.arrayBuffer()).byteLength, 100);
});

test("limits and clear errors", async t => {
  const { server } = createApp({ groqKey: "test", dataDir: path.join(tmp, "d2"), fetchFn: mockFetch([]), env: {}, limits: { uploads: 100 }, plans: { free: { name: "free", maxSeconds: 3, maxBytes: 50 * 1048576, perDay: 2, watermark: true } } });
  await new Promise(r => server.listen(0, r)); const base = "http://127.0.0.1:" + server.address().port; t.after(() => server.close());
  let r = await upload(base, sample); assert.equal(r.status, 400); assert.match((await r.json()).error, /5 seconds.*limit/);          // too long
  const bad = path.join(tmp, "x.txt"); fs.writeFileSync(bad, "hi"); r = await upload(base, bad); assert.equal(r.status, 400); assert.match((await r.json()).error, /MP4 or MOV/);
  const fake = path.join(tmp, "fake.mp4"); fs.writeFileSync(fake, "not a video at all"); r = await upload(base, fake); assert.equal(r.status, 400); assert.match((await r.json()).error, /not a readable video/);
  assert.equal((await fetch(base + "/api/jobs/abcdef")).status, 404);
  const none = createApp({ groqKey: "", dataDir: path.join(tmp, "d3"), env: {} }); await new Promise(r => none.server.listen(0, r)); t.after(() => none.server.close());
  r = await upload("http://127.0.0.1:" + none.server.address().port, sample); assert.equal(r.status, 400); assert.match((await r.json()).error, /Groq key/);
});

test("free plan: 3 videos per day then a clear message (cookie based)", async t => {
  const { server } = createApp({ groqKey: "test", dataDir: path.join(tmp, "d4"), fetchFn: mockFetch([]), env: { FREE_PER_DAY: "3" }, limits: { uploads: 100 } });
  await new Promise(r => server.listen(0, r)); const base = "http://127.0.0.1:" + server.address().port; t.after(() => server.close());
  let cookie = null, codes = [], last;
  for (let i = 0; i < 4; i++) { const r = await upload(base, sample, {}, cookie ? { Cookie: cookie } : {}); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; codes.push(r.status); last = await r.json(); }
  assert.deepEqual(codes, [200, 200, 200, 429]); assert.match(last.error, /3 videos per day/);
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("each visitor's own Groq key is used, never exposed, and required when the owner has none", async t => {
  const seen = [], f = mockFetch([]);
  const fetchFn = async (url, init) => { seen.push(init.headers.Authorization); return f(url, init); };
  const MINE = "gsk_" + "a".repeat(40), OTHER = "gsk_" + "b".repeat(40);
  const { server } = createApp({ groqKey: "", dataDir: path.join(tmp, "data-k"), fetchFn, env: { TRUST_PROXY: "0" } });
  await new Promise(r => server.listen(0, r)); const base = "http://127.0.0.1:" + server.address().port; t.after(() => server.close());
  const cfg = await (await fetch(base + "/api/config")).json(); assert.equal(cfg.needKey, true); assert.equal(cfg.ready, true);

  let r = await upload(base, sample, { spelling: "simple" }); assert.equal(r.status, 400); assert.match((await r.json()).error, /Groq key/);
  r = await upload(base, sample, { groqKey: "not a key" }); assert.equal(r.status, 400); assert.match((await r.json()).error, /gsk_/);

  // two people queue up, each with their own key
  const [a, b] = await Promise.all([upload(base, sample, { groqKey: MINE }), upload(base, sample, { groqKey: OTHER })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const ia = (await a.json()).id, ib = (await b.json()).id;
  const ra = await wait(base, ia, "review"), rb = await wait(base, ib, "review");
  assert.equal(ra.status, "review"); assert.equal(rb.status, "review");
  assert.ok(seen.includes("Bearer " + MINE) && seen.includes("Bearer " + OTHER), "both keys were used");
  for (const j of [ra, rb]) assert.ok(!JSON.stringify(j).includes("gsk_"), "key never appears in API output");
});

test("owner key is the fallback, but USER_KEY_ONLY turns it off", async t => {
  const calls = [];
  const on = createApp({ groqKey: "gsk_" + "o".repeat(40), dataDir: path.join(tmp, "data-o1"), fetchFn: mockFetch(calls), env: {} });
  const off = createApp({ groqKey: "gsk_" + "o".repeat(40), dataDir: path.join(tmp, "data-o2"), fetchFn: mockFetch(calls), env: { USER_KEY_ONLY: "1" } });
  for (const s of [on, off]) await new Promise(r => s.server.listen(0, r)); t.after(() => { on.server.close(); off.server.close(); });
  const b1 = "http://127.0.0.1:" + on.server.address().port, b2 = "http://127.0.0.1:" + off.server.address().port;
  assert.equal((await (await fetch(b1 + "/api/config")).json()).needKey, false);
  assert.equal((await (await fetch(b2 + "/api/config")).json()).needKey, true);
  const ok = await upload(b1, sample, {}); assert.equal(ok.status, 200); assert.equal((await wait(b1, (await ok.json()).id, "review")).status, "review");
  assert.equal((await upload(b2, sample, {})).status, 400);
});
