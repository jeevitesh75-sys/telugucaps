---
title: TeluguCaps
emoji: 🎬
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# TeluguCaps

Upload a video of someone speaking Telugu. Get the **same video** back with burned-in captions in **English letters** (`nenu repu vastanu`). This is transliteration, not translation.

Flow: upload → options → AI writes captions → **you check and fix every line** → pick a style → download.
Stack: Node 18+ (no npm packages), ffmpeg, Groq (Whisper large-v3 + `openai/gpt-oss-120b`).

## 0. How keys work (new)
Every visitor pastes **their own free Groq key** on the page (the browser can remember it on their phone). It is sent only with their upload, used only for their video, kept in memory and never saved on the server. All videos wait in one line, one at a time. So you do not need to add any key to the host. (Optional: set `GROQ_API_KEY` as a shared fallback, or `USER_KEY_ONLY=1` to force everyone to use their own.)

## 1. Get a Groq key (free, no card)
1. Open https://console.groq.com and sign in with Google.
2. API Keys → Create API Key → copy it (starts with `gsk_`).
3. Never paste it in chat or in git. Visitors paste theirs into the page box. Only if you want a shared fallback key, add it in the host's "Secrets" (step 3).

## 2. Free hosting (phone only)
Vercel cannot run this (ffmpeg, big uploads, long jobs). Use a Docker host:

**Option A: Hugging Face Spaces (try first)**
1. Sign up at https://huggingface.co (email only). Check what it asks during sign-up; it may change.
2. New → Space → name `telugucaps` → SDK **Docker** → Blank → **CPU basic (free)** → Public or Private → Create.
3. Space → Settings → **Variables and secrets** → New secret: name `GROQ_API_KEY`, value = your key.
4. Put the code in the Space. In Termux:
```
pkg install git unzip -y
unzip telugucaps.zip && cd telugucaps
git init -b main
git add . && git commit -m "TeluguCaps"
git remote add space https://huggingface.co/spaces/YOUR_HF_NAME/telugucaps
git push space main --force
```
   When git asks for a password, use a Hugging Face **write token** (huggingface.co → Settings → Access Tokens → Write).
5. The Space builds (about 3-6 minutes). When it says **Running**, open the link `https://YOUR_HF_NAME-telugucaps.hf.space`.

**Option B: Render** (https://render.com): New → Web Service → connect a GitHub repo with this code → Runtime **Docker** → Free instance → add env var `GROQ_API_KEY`. Some hosts ask for a card for Render; if so use option A.

Free hosts are slow and sleep when idle: the first visit after a pause takes about a minute, and long videos take a few minutes. Files are stored on temporary disk and are deleted after 1 hour (and lost on restart).

## 3. Run it on a computer
```
cp .env.example .env     # then edit .env and paste your key
npm start                # http://localhost:7860
npm test                 # needs ffmpeg installed
```

## Limits (free plan) and the paid hook
3 videos/day per visitor (cookie, with a looser IP backstop), 3 minutes, 200 MB, small "Made with TeluguCaps" watermark, per-IP rate limits.
Paid tier: see `PLANS` and `planFor()` in `server/app.js` (no watermark, 15 minutes, 500 MB). Today it is switched on by an `x-paid-key` header that matches `PAID_KEYS`. Replace that with your real login or licence check later.

## Quality
Video is re-encoded with x264 CRF 16, same resolution and frame rate, rotation metadata kept. Audio is copied bit for bit (`-c:a copy`; it is only re-encoded if the original codec cannot go in MP4). After rendering, the server re-reads the file and shows "Quality kept: WxH, N fps, audio unchanged" only if that is really true. File size can go up or down a little.

## Honest notes
- Spelling is the weak spot (many valid spellings), so the edit step is never skipped. Lines where Whisper was unsure are marked orange.
- If the AI returns something unusable for a word, an offline basic transliteration is used for that word, so check those lines.
- Files: `server/` backend, `public/` web page, `tests/` (`npm test`), `Dockerfile`.
