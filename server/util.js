"use strict";
// Small helpers so the whole project needs zero npm packages.
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

const json = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": b.length }); res.end(b); };
const fail = (code, message) => Object.assign(new Error(message), { code });

async function readJson(req, max = 2e6) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw fail(413, "Request is too big"); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail(400, "Bad JSON"); }
}

// Sends a file with Range support (needed so the video player can seek on phones)
function sendFile(req, res, file, { download, type } = {}) {
  let st; try { st = fs.statSync(file); } catch { return json(res, 404, { error: "Not found" }); }
  const headers = { "Content-Type": type || TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (download) headers["Content-Disposition"] = `attachment; filename="${download.replace(/[^\w.\- ]/g, "_")}"`;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let start = 0, end = st.size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    start = m[1] === "" ? Math.max(0, st.size - +m[2]) : +m[1]; end = m[1] !== "" && m[2] !== "" ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
    code = 206; headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  }
  headers["Content-Length"] = end - start + 1; res.writeHead(code, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
}

// Streaming multipart/form-data parser (writes the file straight to disk, never holds it in memory)
async function parseMultipart(req, { sink, maxFileBytes, maxFieldBytes = 20000 }) {
  const ct = req.headers["content-type"] || "", bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!/multipart\/form-data/i.test(ct) || !bm) throw fail(400, "Send the video as a file upload");
  const delim = Buffer.from("\r\n--" + (bm[1] || bm[2]));
  let buf = Buffer.from("\r\n"), state = "boundary", cur = null; const fields = {}; let file = null;
  const write = (stream, data) => new Promise((ok, no) => stream.write(data, e => e ? no(e) : ok()));
  const endPart = async () => {
    if (!cur) return;
    if (cur.stream) { await new Promise(r => cur.stream.end(r)); file = { ...cur.info, size: cur.size }; }
    else fields[cur.name] = Buffer.concat(cur.chunks).toString("utf8");
    cur = null;
  };
  for await (const chunk of req) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (state === "boundary") {                           // looking for the first boundary
        const i = buf.indexOf(delim); if (i < 0) { buf = buf.subarray(Math.max(0, buf.length - delim.length)); break; }
        buf = buf.subarray(i + delim.length); state = "after";
      }
      if (state === "after") {
        if (buf.length < 2) break;
        if (buf[0] === 45 && buf[1] === 45) { await endPart(); return { fields, file }; }
        buf = buf.subarray(2); state = "headers";
      }
      if (state === "headers") {
        const i = buf.indexOf("\r\n\r\n"); if (i < 0) { if (buf.length > 16000) throw fail(400, "Bad upload"); break; }
        const head = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 4);
        const name = (/name="([^"]*)"/i.exec(head) || [])[1], fname = (/filename="([^"]*)"/i.exec(head) || [])[1];
        if (fname !== undefined && fname !== "") { const s = sink(fname); cur = { name, stream: s.stream, info: { name: fname, path: s.path, field: name }, size: 0 }; }
        else cur = { name, chunks: [], size: 0 };
        state = "body";
      }
      if (state === "body") {
        const i = buf.indexOf(delim);
        const take = i >= 0 ? buf.subarray(0, i) : buf.subarray(0, Math.max(0, buf.length - delim.length + 1));
        if (take.length) {
          cur.size += take.length;
          if (cur.stream) { if (cur.size > maxFileBytes) throw fail(413, `The video is too big (max ${Math.round(maxFileBytes / 1048576)} MB)`); await write(cur.stream, take); }
          else { if (cur.size > maxFieldBytes) throw fail(400, "Bad form data"); cur.chunks.push(Buffer.from(take)); }
        }
        if (i >= 0) { buf = buf.subarray(i + delim.length); await endPart(); state = "after"; continue; }
        buf = buf.subarray(take.length); break;
      }
    }
  }
  throw fail(400, "The upload was cut off. Please try again.");
}

// tiny in-memory counters (rate limits, free daily quota)
class Counter {
  constructor() { this.m = new Map(); }
  hit(key, windowMs) { const now = Date.now(), a = (this.m.get(key) || []).filter(t => now - t < windowMs); a.push(now); this.m.set(key, a); return a.length; }
  count(key, windowMs) { const now = Date.now(); return (this.m.get(key) || []).filter(t => now - t < windowMs).length; }
  sweep(windowMs) { const now = Date.now(); for (const [k, a] of this.m) { const f = a.filter(t => now - t < windowMs); f.length ? this.m.set(k, f) : this.m.delete(k); } }
}

const rid = (n = 8) => crypto.randomBytes(n).toString("hex");
module.exports = { json, fail, readJson, sendFile, parseMultipart, Counter, rid, TYPES };
