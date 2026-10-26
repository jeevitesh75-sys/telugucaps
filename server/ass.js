"use strict";
const { lineWords } = require("./captions");

const STYLES = {
  classic: { name: "Classic", font: "Poppins", bold: 1, color: "#FFFFFF", hi: "#FFE600", outline: 0.085, shadow: 0 },
  yellow:  { name: "Yellow bold", font: "Poppins", bold: 1, color: "#FFE600", hi: "#FFFFFF", outline: 0.085, shadow: 0 },
  karaoke: { name: "Karaoke", font: "Montserrat", bold: 1, color: "#FFFFFF", hi: "#FFD400", outline: 0.08, shadow: 0, karaoke: true },
  pop:     { name: "Pop-in", font: "Poppins", bold: 1, color: "#FFFFFF", hi: "#FFD400", outline: 0.085, shadow: 0, pop: true },
  glow:    { name: "Neon glow", font: "Montserrat", bold: 1, color: "#FFFFFF", hi: "#00E5FF", outline: 0.03, shadow: 0, glow: true },
  box:     { name: "Box", font: "Poppins", bold: 1, color: "#FFFFFF", hi: "#FFD400", outline: 0.2, shadow: 0, box: true },
  minimal: { name: "Minimal", font: "Montserrat", bold: 0, color: "#FFFFFF", hi: "#FFFFFF", outline: 0.035, shadow: 0.06, scale: 0.78 },
  reels:   { name: "Big Reels", font: "Anton", bold: 0, color: "#FFFFFF", hi: "#FFD400", outline: 0.1, shadow: 0, scale: 1.7, upper: true }
};

const hex = (c, def) => /^#?[0-9a-f]{6}$/i.test(c || "") ? String(c).replace("#", "").toUpperCase() : def.replace("#", "");
const bgr = h => h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
const sty = (h, a = "00") => `&H${a}${bgr(h)}`;   // for the Style line
const inl = h => `&H${bgr(h)}&`;                  // for {\1c...} tags
const esc = s => String(s).replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\s+/g, " ");
const ts = t => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`; };

// opts: {style,size(0.5-1.5),color,highlight,position:'bottom'|'middle'|'top', watermark:text|null}  video:{width,height} (as displayed)
function buildAss(lines, video, opts = {}) {
  const st = STYLES[opts.style] || STYLES.classic, W = video.width, H = video.height, portrait = H > W;
  const base = portrait ? H * 0.04 : H * 0.055, size = Math.round(base * (st.scale || 1) * Math.min(1.6, Math.max(0.5, +opts.size || 1)));
  const color = hex(opts.color, st.color), hi = hex(opts.highlight, st.hi);
  const pos = opts.position === "top" ? 8 : opts.position === "middle" ? 5 : 2;
  const mv = pos === 2 ? Math.round(H * (portrait ? 0.2 : 0.08)) : pos === 8 ? Math.round(H * 0.1) : 0, ml = Math.round(W * 0.06);
  const outline = Math.max(0.5, +(size * st.outline).toFixed(1)), shadow = +(size * st.shadow).toFixed(1);
  const primary = st.karaoke ? hi : color, secondary = st.karaoke ? color : hi;
  const wmSize = Math.max(12, Math.round(H * (portrait ? 0.0125 : 0.025)));
  const out = [];
  out.push("[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "YCbCr Matrix: None", "");
  out.push("[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding");
  const border = st.box ? 3 : 1, oc = st.box ? sty("000000", "55") : st.glow ? sty(hi) : sty("000000");
  out.push(`Style: Main,${st.font},${size},${sty(primary)},${sty(secondary)},${oc},${sty("000000", "40")},${-st.bold},0,0,0,100,100,0,0,${border},${outline},${shadow},${pos},${ml},${ml},${mv},1`);
  out.push(`Style: WM,Poppins,${wmSize},${sty("FFFFFF", "70")},${sty("FFFFFF")},${sty("000000", "90")},${sty("000000")},0,0,0,0,100,100,0,0,1,1,0,9,${Math.round(W * 0.03)},${Math.round(W * 0.03)},${Math.round(H * 0.025)},1`);
  out.push("", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
  const D = (layer, s, e, text) => out.push(`Dialogue: ${layer},${ts(s)},${ts(e)},Main,,0,0,0,,${text}`);
  const T = r => st.upper ? esc(r).toUpperCase() : esc(r);

  for (const line of lines) {
    if (line.deleted) continue;
    const ws = lineWords(line); if (!ws.length) continue;
    const s = line.start, e = Math.max(line.end, s + 0.3);
    if (st.karaoke) {
      D(0, s, e, ws.map((w, i) => `{\\k${Math.max(1, Math.round(((ws[i + 1] ? ws[i + 1].s : e) - w.s) * 100))}}${T(w.r)}`).join(" "));
    } else if (st.pop) {
      ws.forEach((w, i) => {
        const a = i === 0 ? s : w.s, b = i + 1 < ws.length ? ws[i + 1].s : e; if (b - a < 0.02) return;
        const txt = ws.map((x, j) => j < i ? T(x.r) : j === i ? `{\\1c${inl(hi)}\\fscx65\\fscy65\\t(0,110,\\fscx100\\fscy100)}${T(x.r)}{\\1c${inl(color)}\\fscx100\\fscy100}` : `{\\alpha&HFF&}${T(x.r)}{\\alpha&H00&}`).join(" ");
        D(0, a, b, txt);
      });
    } else if (st.glow) {
      const t = ws.map(w => T(w.r)).join(" ");
      D(0, s, e, `{\\1a&HFF&\\bord${(size * 0.14).toFixed(1)}\\3c${inl(hi)}\\blur${Math.round(size * 0.14)}}${t}`);
      D(1, s, e, `{\\bord${(size * 0.03).toFixed(1)}\\3c${inl(hi)}}${t}`);
    } else D(0, s, e, ws.map(w => T(w.r)).join(" "));
  }
  if (opts.watermark) out.push(`Dialogue: 9,${ts(0)},${ts(36000)},WM,,0,0,0,,${esc(opts.watermark)}`);
  return out.join("\n") + "\n";
}
module.exports = { buildAss, STYLES, ts, hex };
