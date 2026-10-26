"use strict";
const $ = id => document.getElementById(id);
const st = { cfg: null, id: null, lines: [], style: "classic", img: null, info: null, cur: 0 };
function show(id) {
  ["s1", "busy", "s2", "s3"].forEach(k => { $(k).hidden = k !== id; });
  if (id === "s1") renderHistory(); else $("hist").hidden = true;
}
const err = m => { const b = $("banner"); b.textContent = m; b.hidden = !m; if (m) window.scrollTo({ top: 0, behavior: "smooth" }); };
async function api(url, opt) { const r = await fetch(url, opt); let j = {}; try { j = await r.json(); } catch {} if (!r.ok) throw new Error(j.error || "Request failed (" + r.status + ")"); return j; }

(async function init() {
  try { st.cfg = await api("/api/config"); } catch (e) { return err("Cannot reach the server. " + e.message); }
  const c = st.cfg;
  $("limits").textContent = `Up to ${Math.round(c.maxSeconds / 60)} minutes, ${c.maxMB} MB` + (c.perDay ? `, ${c.perDay} videos per day.` : ".") + (c.watermark ? ' Small "Made with TeluguCaps" mark in the corner.' : "");
  $("keyOpt").textContent = c.needKey ? "(needed)" : "(optional, leave empty to use the shared one)";
  syncGo();
  const box = $("styles");
  for (const [k, s] of Object.entries(c.styles)) { const b = document.createElement("button"); b.className = "sty" + (k === st.style ? " on" : ""); b.textContent = s.name; b.onclick = () => { st.style = k; [...box.children].forEach(x => x.classList.toggle("on", x === b)); const t = c.styles[k]; $("col").value = t.color; $("hi").value = t.hi; draw(); }; box.appendChild(b); }
  setColors(); renderHistory(); syncGo();
})();
function setColors() { const t = st.cfg.styles[st.style]; $("col").value = t.color; $("hi").value = t.hi; }

// The <label class="drop"> opens the file picker by itself. Do NOT call file.click() again (that opened it twice).
// Reset the value on click so choosing the same video again still fires "change".
$("file").addEventListener("click", () => { $("file").value = ""; });
const KEYRE = /^gsk_[A-Za-z0-9_-]{20,200}$/, KK = "tc_gkey";
const keyVal = () => $("gkey").value.trim();
const keyOk = () => KEYRE.test(keyVal()) || (!!st.cfg && !st.cfg.needKey && !keyVal());   // own key, or owner key as fallback when blank
function syncGo() { const f = $("file").files[0]; $("go").disabled = !(f && st.cfg && st.cfg.ready && keyOk() && (!st.cfg.maxMB || f.size / 1048576 <= st.cfg.maxMB)); }
try { $("gkey").value = localStorage.getItem(KK) || ""; } catch {}
$("gkey").addEventListener("input", () => { const v = keyVal(); if (v && !KEYRE.test(v)) err("A Groq key starts with gsk_ and has no spaces. Check what you pasted."); else err(""); syncGo(); });
$("file").onchange = () => {
  const f = $("file").files[0]; if (!f) return; err("");
  const mb = f.size / 1048576;
  $("fname").textContent = f.name; $("fhint").textContent = (Math.round(mb * 10) / 10) + " MB";
  $("drop").classList.add("has");
  if (!st.cfg) { $("go").disabled = true; return err("Still connecting to the server. Wait a few seconds and choose the video again."); }
  if (mb > st.cfg.maxMB) { $("go").disabled = true; return err(`This file is ${Math.round(mb)} MB. The limit is ${st.cfg.maxMB} MB.`); }
  syncGo();
};

$("go").onclick = () => {
  const f = $("file").files[0]; if (!f) return; err(""); show("busy"); $("busyT").textContent = "Uploading..."; $("busyN").textContent = "Keep this page open."; $("barI").style.width = "0";
  const fd = new FormData(); fd.append("spelling", $("spelling").value); fd.append("mixed", $("mixed").value); fd.append("perLine", $("perLine").value); if (keyVal()) fd.append("groqKey", keyVal()); fd.append("video", f);
  try { if ($("gremember").checked && keyVal()) localStorage.setItem(KK, keyVal()); else localStorage.removeItem(KK); } catch {}
  const x = new XMLHttpRequest(); x.open("POST", "/api/jobs");
  x.upload.onprogress = e => { if (e.lengthComputable) $("barI").style.width = (e.loaded / e.total * 100) + "%"; };
  x.onerror = () => { show("s1"); err("Upload failed. Check your internet and try again."); };
  x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} if (x.status !== 200) { show("s1"); return err(j.error || "Upload failed"); } st.id = j.id; hadd(j.id, f.name.slice(0, 28)); poll(); };
  x.send(fd);
};

const LABEL = { queued: "Waiting in line (other people's videos go first)...", extracting: "Getting the audio...", transcribing: "Listening to the Telugu speech...", romanizing: "Writing in English letters...", rendering: "Putting captions on your video...", uploading: "Uploading..." };
async function poll() {
  let j; try { j = await api("/api/jobs/" + st.id); } catch (e) { show("s1"); return err(e.message); }
  if (j.status === "error") { show("s1"); return err(j.error); }
  st.info = j.info;
  if (j.status === "review") return review(j);
  if (j.status === "done") return done(j);
  show("busy"); $("busyT").textContent = LABEL[j.status] || "Working..."; $("barI").style.width = Math.max(4, j.progress * 100) + "%";
  $("busyN").textContent = j.queue ? `${j.queue} video(s) before yours.` : "This can take a minute or two for longer videos.";
  setTimeout(poll, 1500);
}

const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ":" + s.toFixed(1).padStart(4, "0"); };
function review(j) {
  show("s2"); st.lines = j.lines;
  const box = $("lines"); box.innerHTML = "";
  st.lines.forEach((l, i) => {
    const d = document.createElement("div"); d.className = "ln" + (l.low ? " low" : "") + (l.deleted ? " del" : "");
    const tm = document.createElement("span"); tm.className = "tm"; tm.textContent = fmt(l.start);
    const inp = document.createElement("input"); inp.type = "text"; inp.value = l.text; inp.autocapitalize = "none"; inp.spellcheck = false;
    inp.oninput = () => { l.text = inp.value; st.cur = i; draw(); }; inp.onfocus = () => { st.cur = i; draw(); };
    const del = document.createElement("button"); del.textContent = l.deleted ? "Undo" : "Delete"; del.onclick = () => { l.deleted = !l.deleted; d.classList.toggle("del", l.deleted); del.textContent = l.deleted ? "Undo" : "Delete"; };
    d.append(tm, inp, del); if (l.low) { const t = document.createElement("div"); t.className = "low-tag"; t.textContent = "Not sure about this line. Please check."; d.append(t); }
    box.appendChild(d);
  });
  const img = new Image(); img.onload = () => { st.img = img; draw(); }; img.src = "/api/jobs/" + st.id + "/frame";
  window.scrollTo({ top: 0 });
}

// live preview: same size rules as the server (ass.js)
const SCALE = { classic: 1, yellow: 1, karaoke: 1, pop: 1, glow: 1, box: 1, minimal: .78, reels: 1.7 };
function draw() {
  const c = $("pv"), img = st.img; if (!img || !st.info) return;
  const W = st.info.width, H = st.info.height, k = Math.min(1, 640 / W); c.width = Math.round(W * k); c.height = Math.round(H * k);
  const g = c.getContext("2d"); g.drawImage(img, 0, 0, c.width, c.height);
  const s = st.cfg.styles[st.style], portrait = H > W, size = (portrait ? H * .04 : H * .055) * (SCALE[st.style] || 1) * ($("size").value / 100) * k;
  const l = st.lines[st.cur] || st.lines[0]; let txt = (l && l.text) || "nenu repu vastanu"; if (s.upper) txt = txt.toUpperCase();
  g.font = `${s.bold ? 700 : 400} ${size}px ${s.font}, Poppins, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
  const words = txt.split(/\s+/), maxW = c.width * .88, lines = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } lines.push(cur);
  const pos = $("pos").value, lh = size * 1.25, total = lh * lines.length;
  let y0 = pos === "top" ? c.height * .1 + lh / 2 : pos === "middle" ? c.height / 2 - total / 2 + lh / 2 : c.height - c.height * (portrait ? .2 : .08) - total + lh / 2;
  const col = $("col").value, hi = $("hi").value;
  lines.forEach((ln, i) => { const y = y0 + i * lh, x = c.width / 2, w = g.measureText(ln).width;
    if (s.name === "Box") { g.fillStyle = "rgba(0,0,0,.65)"; g.fillRect(x - w / 2 - size * .3, y - lh / 2, w + size * .6, lh); }
    else if (st.style === "glow") { g.shadowColor = hi; g.shadowBlur = size * .5; g.strokeStyle = hi; g.lineWidth = size * .04; g.strokeText(ln, x, y); g.shadowBlur = 0; }
    else if (st.style === "minimal") { g.shadowColor = "rgba(0,0,0,.8)"; g.shadowBlur = size * .15; }
    else { g.strokeStyle = "#000"; g.lineWidth = size * (st.style === "reels" ? .2 : .17); g.strokeText(ln, x, y); }
    g.fillStyle = col; g.fillText(ln, x, y); g.shadowBlur = 0;
    if (["karaoke", "pop"].includes(st.style) && i === 0) { const fw = ln.split(" ")[0]; g.textAlign = "left"; g.fillStyle = hi; g.fillText(fw, x - w / 2, y); g.textAlign = "center"; }
  });
}
["size", "pos", "col", "hi"].forEach(i => $(i).addEventListener("input", draw));

async function save() { await api(`/api/jobs/${st.id}/captions`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines: st.lines }) }); }
$("make").onclick = async () => {
  try { err(""); await save(); await api(`/api/jobs/${st.id}/render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style: { style: st.style, size: $("size").value / 100, color: $("col").value, highlight: $("hi").value, position: $("pos").value } }) });
    show("busy"); $("busyT").textContent = "Starting..."; setTimeout(poll, 600); } catch (e) { err(e.message); }
};
function done(j) {
  show("s3");
  $("player").src = `/api/jobs/${st.id}/preview`; $("dl").href = `/api/jobs/${st.id}/download`;
  $("quality").textContent = j.quality ? j.quality.text : ""; $("wm").textContent = j.plan && j.plan.watermark ? 'Free version has a small "Made with TeluguCaps" mark.' : "";
}
$("again").onclick = () => location.reload();

// ---- history (kept in this browser only; videos themselves are deleted from the server after 1 hour) ----
const HK = "tc_history";
const hget = () => { try { return JSON.parse(localStorage.getItem(HK)) || []; } catch { return []; } };
const hset = a => { try { localStorage.setItem(HK, JSON.stringify(a.slice(0, 30))); } catch {} };
function hadd(id, name) { const a = hget().filter(x => x.id !== id); a.unshift({ id, name, t: Date.now() }); hset(a); }
async function renderHistory() {
  const a = hget(), box = $("hist"), list = $("histList"); list.innerHTML = ""; if (!a.length) { box.hidden = true; return; }
  const keep = [];
  for (const h of a) {
    let j = null; try { const r = await fetch("/api/jobs/" + h.id); if (r.ok) j = await r.json(); } catch { j = { status: "?" }; }
    if (!j) continue; keep.push(h);
    const d = document.createElement("div"); d.className = "ln";
    const label = { done: "Ready", review: "Check captions", error: "Failed" }[j.status] || "Working...";
    const left = j.expiresAt ? Math.max(0, Math.round((j.expiresAt - Date.now()) / 60000)) : null;
    d.innerHTML = ""; const tm = document.createElement("span"); tm.className = "tm"; tm.textContent = new Date(h.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const nm = document.createElement("div"); nm.textContent = `${h.name} - ${label}` + (left !== null ? ` (${left} min left)` : ""); nm.style.fontSize = "14px";
    const b = document.createElement("button"); b.textContent = j.status === "error" ? "-" : "Open"; b.disabled = j.status === "error";
    b.onclick = () => { st.id = h.id; poll(); }; d.append(tm, nm, b); list.appendChild(d);
  }
  hset(keep); box.hidden = !keep.length;
}
