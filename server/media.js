"use strict";
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), crypto = require("crypto");

function run(cmd, args, { onLine } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
    p.stdout.on("data", d => { out += d; if (onLine) String(d).split("\n").forEach(l => l && onLine(l)); });
    p.stderr.on("data", d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on("error", e => no(Object.assign(new Error(cmd + " is not installed on the server"), { cause: e })));
    p.on("close", c => c === 0 ? ok(out) : no(new Error(`${cmd} failed: ${err.slice(-400)}`)));
  });
}

async function probe(file) {
  const j = JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]));
  const v = (j.streams || []).find(s => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic)), a = (j.streams || []).find(s => s.codec_type === "audio");
  if (!v) return null;
  let rot = 0;
  if (v.tags && v.tags.rotate) rot = +v.tags.rotate;
  for (const sd of v.side_data_list || []) if (sd.rotation !== undefined) rot = +sd.rotation;
  const swap = Math.abs(rot) % 180 === 90;
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || "30/1").split("/").map(Number);
  const fps = d ? n / d : n;
  return { width: swap ? v.height : v.width, height: swap ? v.width : v.height, codedWidth: v.width, codedHeight: v.height, rotation: rot, fps: Math.round(fps * 100) / 100,
    duration: +(j.format.duration || v.duration || 0), audio: a ? a.codec_name : null, vcodec: v.codec_name };
}

const extractArgs = (inp, out) => ["-y", "-v", "error", "-i", inp, "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out];

// 16 kHz mono 16-bit = 32000 bytes/s, so 600 s = 19.2 MB (< 24 MB). Longer audio is cut into 600 s pieces.
async function extractAudio(video, dir, duration, chunk = 600) {
  const full = path.join(dir, "audio.wav"); await run("ffmpeg", extractArgs(video, full));
  if (duration <= chunk) return [{ path: full, offset: 0 }];
  const parts = [];
  for (let off = 0, i = 0; off < duration; off += chunk, i++) {
    const p = path.join(dir, `a${i}.wav`); await run("ffmpeg", ["-y", "-v", "error", "-ss", String(off), "-t", String(chunk), "-i", full, "-c", "copy", p]); parts.push({ path: p, offset: off });
  }
  fs.unlinkSync(full); return parts;
}

const filterPath = p => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
const AUDIO_COPY_OK = new Set(["aac", "mp3", "ac3", "eac3", "alac", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le"]);

function buildFfmpegArgs({ input, output, ass, fontsDir, audioCodec }) {
  const vf = `ass='${filterPath(ass)}'` + (fontsDir ? `:fontsdir='${filterPath(fontsDir)}'` : "");
  const copy = !audioCodec || AUDIO_COPY_OK.has(audioCodec);
  return ["-y", "-v", "error", "-nostats", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf,
    "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-x264-params", "rc-lookahead=20", "-threads", "2", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
    "-c:a", copy ? "copy" : "aac", ...(copy ? [] : ["-b:a", "256k"]), "-map_metadata", "0", "-movflags", "+faststart", "-progress", "pipe:1", output];
}

async function render({ input, output, ass, fontsDir, audioCodec, duration, onProgress }) {
  const args = buildFfmpegArgs({ input, output, ass, fontsDir, audioCodec });
  await run("ffmpeg", args, { onLine: l => { const m = /^out_time_ms=(\d+)/.exec(l); if (m && duration && onProgress) onProgress(Math.min(0.99, +m[1] / 1e6 / duration)); } });
}

const audioMd5 = async f => { const o = await run("ffmpeg", ["-v", "error", "-i", f, "-map", "0:a:0", "-c", "copy", "-f", "md5", "-"]); return o.trim(); };

// Compare input and output. "audioSame" is only true when the audio bytes are identical (md5 of the stream).
async function verify(input, output, before) {
  const after = await probe(output);
  const sameSize = !!after && after.width === before.width && after.height === before.height;
  const sameFps = !!after && Math.abs(after.fps - before.fps) < 0.05;
  let audioSame = false;
  if (!before.audio) audioSame = !after.audio;
  else if (after && after.audio) { try { audioSame = (await audioMd5(input)) === (await audioMd5(output)); } catch {} }
  const text = sameSize && sameFps ? `Quality kept: ${after.width}x${after.height}, ${Math.round(after.fps * 100) / 100} fps, ` + (audioSame ? "audio unchanged" : "audio re-encoded at high quality") : `Output is ${after ? after.width + "x" + after.height + ", " + after.fps + " fps" : "unreadable"}`;
  return { sameSize, sameFps, audioSame, width: after && after.width, height: after && after.height, fps: after && after.fps, text, ok: sameSize && sameFps };
}

async function frameAt(input, t, out) { await run("ffmpeg", ["-y", "-v", "error", "-ss", String(Math.max(0, t)), "-i", input, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "4", out]); }

module.exports = { run, probe, extractAudio, extractArgs, buildFfmpegArgs, render, verify, audioMd5, filterPath, frameAt };
