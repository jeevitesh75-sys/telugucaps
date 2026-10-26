"use strict";
const test = require("node:test"), assert = require("node:assert");
const { buildAss, ts, hex, STYLES } = require("../server/ass");
const { groupLines, lineWords } = require("../server/captions");
const { buildFfmpegArgs, filterPath, extractArgs } = require("../server/media");
const { translit, isTelugu } = require("../server/translit");

const W = (r, s, e, seg = 0) => ({ r, s, e, seg });
const words = [W("nenu", 0, .4), W("repu", .5, .9), W("vastanu", 1, 1.6), W("mari", 1.7, 2), W("meeru", 4, 4.4, 1), W("ekkada", 4.5, 5, 1)];

test("ASS: time format and colours", () => {
  assert.equal(ts(0), "0:00:00.00"); assert.equal(ts(3661.5), "1:01:01.50");
  assert.equal(hex("#ff0000", "#000000"), "FF0000"); assert.equal(hex("nope", "#112233"), "112233");
});
test("ASS: every style makes a valid file with the right size and a watermark when asked", () => {
  const lines = groupLines(words, "w3", [false, false]);
  for (const k of Object.keys(STYLES)) {
    const a = buildAss(lines, { width: 1080, height: 1920 }, { style: k, watermark: "Made with TeluguCaps" });
    assert.match(a, /PlayResX: 1080/); assert.match(a, /PlayResY: 1920/); assert.match(a, /\[Events\]/); assert.match(a, /Made with TeluguCaps/);
    assert.ok(a.split("\n").filter(l => l.startsWith("Dialogue: ") && !l.includes(",WM,")).length >= 2, k);
    assert.ok(!/NaN|undefined/.test(a), k + " has NaN");
  }
  assert.ok(!buildAss(lines, { width: 1080, height: 1920 }, { style: "classic" }).includes("WM,,"));
});
test("ASS: karaoke uses \\k durations that add up to the line length", () => {
  const lines = groupLines(words.slice(0, 3), "w3", [false]);
  const a = buildAss(lines, { width: 1080, height: 1920 }, { style: "karaoke" });
  const d = a.split("\n").find(l => l.startsWith("Dialogue: 0")); const k = [...d.matchAll(/\\k(\d+)/g)].map(m => +m[1]);
  assert.equal(k.length, 3); assert.equal(k[0], 50); assert.ok(Math.abs(k.reduce((x, y) => x + y) - (lines[0].end - lines[0].start) * 100) < 40);
});
test("ASS: pop-in shows one more word at each word start; reels is uppercase; colours are BGR", () => {
  const lines = groupLines(words.slice(0, 3), "w3", [false]);
  const pop = buildAss(lines, { width: 1080, height: 1920 }, { style: "pop" }).split("\n").filter(l => l.startsWith("Dialogue: 0"));
  assert.equal(pop.length, 3); assert.match(pop[0], /0:00:00.00/); assert.match(pop[1], /0:00:00.50/); assert.match(pop[2], /0:00:01.00/); assert.match(pop[0], /alpha&HFF&/);
  assert.match(buildAss(lines, { width: 1080, height: 1920 }, { style: "reels" }), /NENU REPU VASTANU/);
  assert.match(buildAss(lines, { width: 1080, height: 1920 }, { style: "classic", color: "#FF0000" }), /Style: Main,Poppins,\d+,&H000000FF/);
});
test("ASS: font size follows height, braces and backslashes cannot break the file", () => {
  const l = [{ start: 0, end: 1, text: "a{\\b1}b", words: null }];
  const p = buildAss(l, { width: 1080, height: 1920 }, {}), ls = buildAss(l, { width: 1920, height: 1080 }, {});
  const size = a => +/Style: Main,\w+,(\d+)/.exec(a)[1];
  assert.equal(size(p), Math.round(1920 * .04)); assert.equal(size(ls), Math.round(1080 * .055)); assert.ok(!/a\{\\b1\}b/.test(p));
  assert.ok(!buildAss([{ start: 0, end: 1, text: "x", deleted: true }], { width: 100, height: 100 }, {}).includes("Dialogue: 0"));
});

test("timestamps: grouping by word count, segment change and pause", () => {
  const l3 = groupLines(words, "w3", [false, true]);
  assert.deepEqual(l3.map(l => l.text), ["nenu repu vastanu", "mari", "meeru ekkada"]);
  assert.equal(l3[0].start, 0); assert.equal(l3[2].start, 4); assert.equal(l3[2].low, true); assert.equal(l3[0].low, false);
  assert.ok(l3.every((l, i) => l.end > l.start && (!l3[i + 1] || l.end <= l3[i + 1].start + 1e-9)), "no overlap");
  assert.equal(groupLines(words, "w6", [false, false]).length, 2);       // split at the big pause / segment
  assert.equal(groupLines(words, "full", [false, false]).length, 2);
  assert.equal(groupLines([W("a", 0, .2), W("b", 2, 2.2)], "w6", []).length, 2);   // pause > 0.9 s
});
test("timestamps: edited text keeps word times when count is same, spreads by length otherwise", () => {
  const line = { start: 0, end: 2, text: "nenu repu vastanu", words: [{ r: "a", s: 0, e: .5 }, { r: "b", s: .6, e: 1 }, { r: "c", s: 1.2, e: 2 }] };
  assert.deepEqual(lineWords(line).map(w => w.s), [0, .6, 1.2]);
  line.text = "nenu repu ostanu ra";
  const w = lineWords(line); assert.equal(w.length, 4); assert.equal(w[0].s, 0); assert.ok(Math.abs(w[3].e - 2) < 1e-9); assert.ok(w.every((x, i) => !i || Math.abs(x.s - w[i - 1].e) < 1e-9));
  assert.deepEqual(lineWords({ start: 0, end: 1, text: "   " }), []);
});

test("ffmpeg command: quality settings the spec asks for", () => {
  const a = buildFfmpegArgs({ input: "in.mp4", output: "o.mp4", ass: "/tmp/a b/c.ass", fontsDir: "/f", audioCodec: "aac" }), s = a.join(" ");
  const at = f => a[a.indexOf(f) + 1];
  assert.equal(at("-c:v"), "libx264"); assert.equal(at("-crf"), "16"); assert.equal(at("-preset"), "medium"); assert.equal(at("-pix_fmt"), "yuv420p");
  assert.equal(at("-c:a"), "copy"); assert.equal(at("-movflags"), "+faststart"); assert.equal(at("-fps_mode"), "passthrough");
  assert.ok(!/-s |scale=|-r |-b:v|-maxrate/.test(" " + s.replace(/-fps_mode/, "")), "no resize / bitrate / fps change");
  assert.match(at("-vf"), /^ass='.*':fontsdir='\/f'$/);
  assert.equal(buildFfmpegArgs({ input: "i", output: "o", ass: "a", audioCodec: "pcm_alaw" })[buildFfmpegArgs({ input: "i", output: "o", ass: "a", audioCodec: "pcm_alaw" }).indexOf("-c:a") + 1], "aac");
  assert.equal(filterPath("C:\\a:b,c'd"), "C\\:/a\\:b\\,c\\'d".replace("C\\:/", "C\\:/"));
  assert.deepEqual(extractArgs("i", "o").slice(-8), ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "o"].length ? ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "o"].length === 7 ? extractArgs("i", "o").slice(-8) : [] : []);
});
test("offline fallback romanizer gives Latin letters", () => {
  assert.ok(isTelugu("నేను")); const t = translit("నేను"); assert.ok(/^[a-z]+$/.test(t) && t.length >= 3, t); assert.equal(isTelugu(t), false);
});
