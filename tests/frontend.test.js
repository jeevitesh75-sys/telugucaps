"use strict";
// Runs public/app.js against a tiny fake DOM. Catches the "script crashes on load" class of bug
// (e.g. a stray statement that throws ReferenceError, which leaves the whole page dead).
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), vm = require("vm");
const pub = path.join(__dirname, "..", "public");

function makeEnv(over = {}) {
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8"), els = {};
  const mk = id => { const listeners = {}, e = { id, hidden: /id="(s2|s3|busy|hist|banner)"[^>]*hidden/.test(html) && /^(s2|s3|busy|hist|banner)$/.test(id), textContent: "", value: "", disabled: false, files: [], children: [], style: {}, className: "",
    classList: { _s: new Set(), add(c) { this._s.add(c); }, toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, fire(t) { if (this["on" + t]) this["on" + t](); (listeners[t] || []).forEach(f => f()); },
    appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); }, click() { this.fire("click"); }, getContext() { return new Proxy({}, { get: () => () => ({ width: 10 }), set: () => true }); } };
    Object.defineProperty(e, "innerHTML", { get() { return ""; }, set() { this.children = []; } }); return e; };
  for (const m of html.matchAll(/id="([^"]+)"/g)) els[m[1]] = mk(m[1]);
  const doc = { getElementById: id => els[id] || (els[id] = mk(id)), createElement: () => mk("x") };
  const cfg = { ready: true, needKey: false, plan: "free", maxSeconds: 600, maxMB: 200, perDay: 0, watermark: false, styles: { classic: { name: "Classic", font: "Poppins", bold: true, color: "#ffffff", hi: "#ffd400" } }, perLine: ["w3"], ...over };
  const fetch = async url => ({ ok: true, status: 200, json: async () => (String(url).includes("/api/config") ? cfg : {}) });
  const store = {}, ctx = { document: doc, fetch, console, setTimeout, localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    window: { scrollTo() {} }, Image: function () {}, FormData: function () {}, XMLHttpRequest: function () {}, location: { reload() {} }, URL, JSON, Math, Date, Object, Array, Promise };
  vm.createContext(ctx); return { els, ctx };
}
const tick = () => new Promise(r => setTimeout(r, 20));

test("app.js loads without throwing and fills in the limits text", async () => {
  const { els, ctx } = makeEnv(); vm.runInContext(fs.readFileSync(path.join(pub, "app.js"), "utf8"), ctx); await tick();
  assert.match(els.limits.textContent, /Up to 10 minutes, 200 MB/);
  assert.equal(els.banner.hidden, true);
});

test("choosing a video shows its name and enables Make captions", async () => {
  const { els, ctx } = makeEnv(); vm.runInContext(fs.readFileSync(path.join(pub, "app.js"), "utf8"), ctx); await tick();
  els.file.files = [{ name: "clip.mp4", size: 5 * 1048576 }]; els.file.fire("change");
  assert.equal(els.fname.textContent, "clip.mp4"); assert.equal(els.fhint.textContent, "5 MB"); assert.equal(els.go.disabled, false);
});

test("a file over the limit is refused with a message", async () => {
  const { els, ctx } = makeEnv(); vm.runInContext(fs.readFileSync(path.join(pub, "app.js"), "utf8"), ctx); await tick();
  els.file.files = [{ name: "big.mp4", size: 300 * 1048576 }]; els.file.fire("change");
  assert.equal(els.go.disabled, true); assert.match(els.banner.textContent, /limit is 200 MB/);
});

test("tapping the drop area does not call file.click() a second time", async () => {
  const { els, ctx } = makeEnv(); vm.runInContext(fs.readFileSync(path.join(pub, "app.js"), "utf8"), ctx); await tick();
  let n = 0; els.file.click = () => n++; els.drop.fire("click"); assert.equal(n, 0);
});

test("when every visitor needs their own Groq key, the button waits for a valid key", async () => {
  const { els, ctx } = makeEnv({ needKey: true }); vm.runInContext(fs.readFileSync(path.join(pub, "app.js"), "utf8"), ctx); await tick();
  els.file.files = [{ name: "clip.mp4", size: 5 * 1048576 }]; els.file.fire("change"); assert.equal(els.go.disabled, true);
  els.gkey.value = "hello there"; els.gkey.fire("input"); assert.equal(els.go.disabled, true); assert.match(els.banner.textContent, /gsk_/);
  els.gkey.value = "gsk_" + "x".repeat(40); els.gkey.fire("input"); assert.equal(els.go.disabled, false); assert.equal(els.banner.hidden, true);
});
