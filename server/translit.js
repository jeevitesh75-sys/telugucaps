"use strict";
// Offline Telugu-script -> English letters. Used as a safety net when the AI answer is missing or broken.
const V = { "అ": "a", "ఆ": "aa", "ఇ": "i", "ఈ": "ee", "ఉ": "u", "ఊ": "oo", "ఋ": "ru", "ఎ": "e", "ఏ": "e", "ఐ": "ai", "ఒ": "o", "ఓ": "o", "ఔ": "au" };
const M = { "ా": "a", "ి": "i", "ీ": "ee", "ు": "u", "ూ": "oo", "ృ": "ru", "ె": "e", "ే": "e", "ై": "ai", "ొ": "o", "ో": "o", "ౌ": "au" };
const C = { "క": "k", "ఖ": "kh", "గ": "g", "ఘ": "gh", "ఙ": "ng", "చ": "ch", "ఛ": "chh", "జ": "j", "ఝ": "jh", "ఞ": "ny", "ట": "t", "ఠ": "th", "డ": "d", "ఢ": "dh", "ణ": "n",
  "త": "t", "థ": "th", "ద": "d", "ధ": "dh", "న": "n", "ప": "p", "ఫ": "ph", "బ": "b", "భ": "bh", "మ": "m", "య": "y", "ర": "r", "ల": "l", "వ": "v", "శ": "sh", "ష": "sh",
  "స": "s", "హ": "h", "ళ": "l", "ఱ": "r" };
const isTelugu = s => /[ఀ-౿]/.test(s);

function translit(word) {
  const ch = [...String(word)]; let out = "";
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    if (V[c] !== undefined) out += V[c];
    else if (C[c] !== undefined) {
      out += C[c]; const n = ch[i + 1];
      if (n === "్") i++;                        // virama: no vowel
      else if (M[n] !== undefined) { out += M[n]; i++; }
      else out += "a";                          // inherent a
    } else if (c === "ం" || c === "ఁ") out += "m";
    else if (c === "ః") out += "h";
    else if (c === "్" || c === "‌" || c === "‍") { /* ignore */ }
    else out += c;
  }
  // a trailing inherent "a" after a consonant is usually silent in casual spelling only for a few endings; keep it, spelling edits happen in the review step
  return out;
}
module.exports = { translit, isTelugu };
