# Build Prompt — "Huh?" Chrome Extension

> Paste everything below this line into your coding agent.

---

You are building **Huh?**, a Chrome extension (Manifest V3) that helps a user understand the sentence they just missed in a browser video. The user presses a shortcut. The extension takes the last ~12 seconds of tab audio, transcribes it with Sarvam, translates it into the user's language, explains it in simple words, and can read the explanation aloud. Build it end to end, runnable locally, following the spec below exactly. If an API detail here conflicts with the live docs at https://docs.sarvam.ai, follow the docs and leave a comment in the code.

## 0. Repo layout

```
huh/
├── extension/                 # Chrome MV3 extension (TypeScript + Vite, built to extension/dist)
│   ├── manifest.json
│   ├── src/
│   │   ├── background.ts      # service worker: commands, tab capture, orchestration
│   │   ├── offscreen.html
│   │   ├── offscreen.ts       # holds the MediaStream + rolling PCM ring buffer
│   │   ├── recorder-worklet.ts# AudioWorkletProcessor: downsample to 16 kHz mono, push frames
│   │   ├── content.ts         # injects the card UI (Shadow DOM), pauses/resumes <video>
│   │   ├── card.css
│   │   ├── options.html / options.ts  # target language, voice, clip length, backend URL
│   │   └── lib/wav.ts         # Float32 PCM -> 16-bit WAV encoder
│   └── vite.config.ts
├── server/                    # Thin backend that proxies Sarvam (Node 20 + TypeScript + Hono or Express)
│   ├── src/index.ts
│   ├── src/sarvam.ts          # one typed wrapper per Sarvam API
│   ├── .env.example           # SARVAM_API_KEY=, PORT=8787, ALLOWED_ORIGIN=chrome-extension://<id>
│   └── package.json
└── README.md                  # setup, load-unpacked steps, demo GIF placeholder
```

The Sarvam API key **must never ship inside the extension**. Every Sarvam call goes through `server/`.

## 1. User flow (MVP)

1. The user opens a YouTube video, or any tab playing audio.
2. **Arm:** the user clicks the toolbar icon or presses the shortcut once on that tab. The badge turns green ("ON") and the extension starts buffering tab audio in memory. Audio keeps playing normally.
3. **Trigger:** the user presses **`Alt+H`** (configurable at `chrome://extensions/shortcuts`). If the tab isn't armed yet, the first press arms it and shows a toast: "Huh? is listening — press again after you miss something."
4. The extension:
   - pauses the page's `<video>`,
   - slices the last N seconds from the ring buffer (default 12s, configurable from 5 to 25s),
   - shows a card in the bottom-right of the page with loading states.
5. The card fills in progressively:
   1. **Transcript**, in the original language, with a detected-language chip.
   2. **Translation** into the user's target language.
   3. **Explanation**: a 1–3 sentence plain-language explanation in the target language, plus up to 3 tricky terms with short definitions.
6. Card buttons: **🔊 Listen** (TTS of the explanation), **⏪ Replay** (seek video back N seconds and play), **📋 Copy**, **✕ Close** (resume video).
7. `Esc` closes the card and resumes the video.

## 2. Audio capture — exactly how

Audio can't be recorded after the fact. The extension has to **record continuously into a ring buffer once a tab is armed**.

**Manifest permissions:** `"tabCapture"`, `"offscreen"`, `"storage"`, `"activeTab"`, `"scripting"`. Host permissions: `"<all_urls>"` (for injecting the content script), plus the backend origin.

**Commands** in `manifest.json`:
```json
"commands": {
  "trigger-huh": { "suggested_key": { "default": "Alt+H" }, "description": "Explain what was just said" }
}
```

**Flow:**
1. `background.ts` listens to `chrome.commands.onCommand` and `chrome.action.onClicked`. Both count as user gestures, which `tabCapture` requires.
2. To arm tab `T`:
   - `chrome.tabCapture.getMediaStreamId({ targetTabId: T })` → `streamId`.
   - Make sure an offscreen document exists: `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Buffer tab audio for on-demand transcription' })`.
   - Send `{ type: 'START', streamId, tabId }` to the offscreen document.
3. In `offscreen.ts`:
   ```ts
   const stream = await navigator.mediaDevices.getUserMedia({
     audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as any,
     video: false,
   });
   const ctx = new AudioContext();
   const src = ctx.createMediaStreamSource(stream);
   src.connect(ctx.destination);            // REQUIRED: otherwise the tab goes silent
   await ctx.audioWorklet.addModule('recorder-worklet.js');
   const node = new AudioWorkletNode(ctx, 'recorder');
   src.connect(node);
   ```
4. `recorder-worklet.ts` downmixes to mono, downsamples from `ctx.sampleRate` to **16 kHz** (Sarvam works best at 16 kHz), and posts Float32 frames to the offscreen page. The offscreen page keeps a **ring buffer of 25 seconds** (16000 × 25 samples). Never exceed that, because Sarvam's sync STT limit is 30s.
5. On trigger, the offscreen page copies the last N seconds, encodes them as **16-bit PCM WAV** (`lib/wav.ts`), and returns them to the background as base64 or an ArrayBuffer.
6. **Silence check:** if the clip's RMS is below a threshold, skip the API call and show "Didn't catch any speech in the last N seconds."
7. One armed tab at a time for the MVP. Arming a new tab stops the old stream. Stop capture when the tab closes or navigates to another origin, or when the user clicks the icon again (toggle). Badge: `ON`, or empty.

Don't use `MediaRecorder` with webm chunks for the buffer. Webm chunks can't be sliced and decoded independently. Use raw PCM, then WAV.

## 3. Backend (`server/`) — routes and the exact Sarvam APIs

Base URL: `https://api.sarvam.ai`. Auth header on every call: **`api-subscription-key: ${SARVAM_API_KEY}`**.

You can use the official SDK (`npm i sarvamai`: `SarvamAIClient`) or plain `fetch`. Wrap each API in `src/sarvam.ts` with timeouts (15s) and typed errors.

CORS: allow only `ALLOWED_ORIGIN` (the extension's `chrome-extension://<id>`). Add a simple per-install rate limit (e.g. 20 req/min keyed by an `X-Huh-Install-Id` header the extension generates once and stores in `chrome.storage.local`).

### Route 1 — `POST /api/transcribe`
Input: `multipart/form-data` with `audio` (WAV) and an optional `sourceLang` (default `unknown`).

**Sarvam API: Speech-to-Text (Saaras)**
- `POST https://api.sarvam.ai/speech-to-text` (multipart/form-data)
- Fields:
  - `file`: the WAV
  - `model`: `"saaras:v4"`
  - `mode`: `"transcribe"`, which keeps the original language for the transcript line
  - `language_code`: `"unknown"`, which auto-detects. You can also pass a BCP-47 code such as `hi-IN`, `ta-IN` or `en-IN`.
  - Optional `keyterms`: a JSON array of up to 50 terms. Send the video title's proper nouns here to improve accuracy.
- Response: `{ request_id, transcript, language_code, language_probability? }`
- Errors: `422` means a bad format or audio over 30s. Map it to a friendly card message.

Return `{ transcript, detectedLang }`.

> Alternative for English-target users: `mode: "translate"` returns an English transcript directly in one hop. Use it as a fast path when `targetLang === 'en-IN'` and `detectedLang !== 'en-IN'`.

### Route 2 — `POST /api/translate`
Input: `{ text, sourceLang, targetLang }`. Skip the call and return the input unchanged when the languages are equal.

**Sarvam API: Translate**
- `POST https://api.sarvam.ai/translate` (JSON)
- Body:
  ```json
  {
    "input": "<transcript>",
    "source_language_code": "<detectedLang or 'auto'>",
    "target_language_code": "<targetLang>",
    "model": "sarvam-translate:v1",
    "mode": "formal"
  }
  ```
  - Use `sarvam-translate:v1` (all 22 scheduled languages, 2,000-char limit) by default.
  - Use `mayura:v1` (1,000-char limit) when the user picks a colloquial style in options. It supports `mode: "modern-colloquial" | "classic-colloquial" | "code-mixed"`, which is great for Hinglish videos.
- Response: read `translated_text`.

### Route 3 — `POST /api/explain`
Input: `{ transcript, translation, sourceLang, targetLang, videoTitle, pageUrl, previousTranscript? }`.

**Sarvam API: Chat Completions (LLM)**
- `POST https://api.sarvam.ai/v1/chat/completions` (OpenAI-compatible; accepts the `api-subscription-key` header or `Authorization: Bearer`)
- `model`: `"sarvam-105b"`
- `reasoning_effort: null`, which disables thinking. That keeps latency low, and stops reasoning from eating `max_tokens` and returning empty `content`.
- `max_tokens: 400`, `temperature: 0.3`
- `response_format`: `{ "type": "json_object" }`
- System prompt (put this in code):
  ```
  You help someone who just missed a line in a video. Reply ONLY with JSON:
  {"explanation": string, "terms": [{"term": string, "meaning": string}]}
  - Write in language {targetLang}.
  - "explanation": 1–3 short sentences, plain words, saying what the speaker meant
    in context. Do not repeat the translation verbatim. If the clip starts or ends
    mid-sentence, infer gently and say so.
  - "terms": up to 3 jargon/slang/idioms/names from the clip that a listener might
    not know. Empty array if none.
  - Never invent facts beyond the clip and the provided context.
  ```
- User message: the video title, page domain, previous clip transcript (if any), the transcript, and the translation.
- Parse `choices[0].message.content` as JSON. On a parse failure, retry once, then fall back to `{ explanation: content, terms: [] }`.

### Route 4 — `POST /api/speak`
Input: `{ text, targetLang, speaker? }`.

**Sarvam API: Text-to-Speech (Bulbul)**
- `POST https://api.sarvam.ai/text-to-speech` (JSON)
- Body:
  ```json
  {
    "text": "<explanation, max 2500 chars>",
    "language_code": "<targetLang>",
    "model": "bulbul:v4-flash",
    "speaker": "<from options; omit for default>",
    "pace": 1.0,
    "speech_sample_rate": 24000,
    "output_audio_codec": "mp3"
  }
  ```
  - The field is `language_code`, not `target_language_code`.
  - TTS supports 11 languages: `bn-IN, en-IN, gu-IN, hi-IN, kn-IN, ml-IN, mr-IN, od-IN, pa-IN, ta-IN, te-IN`. Hide the 🔊 button for any other target language.
  - Speaker IDs are lowercase. For `bulbul:v3`, use simple names (`shubh`, `priya`, `kavya`, `rahul`…). For `bulbul:v4-flash`, use persona IDs like `simran_en_customer`. Keep a small curated list in options.
  - Don't send `opus` as the codec on v3 or v4-flash, because it returns a validation error.
- Response: `{ request_id, audios: [base64, ...] }`. Concatenate and return as `audio/mpeg`, or return base64 for the extension to play through `new Audio('data:audio/mpeg;base64,...')`.

### Optional combined route
`POST /api/huh` runs transcribe → (translate ∥ explain), with `explain` waiting only on the transcript. It streams results back as **Server-Sent Events** (`event: transcript`, `event: translation`, `event: explanation`, `event: error`), so the card fills in progressively from a single request. Build this after the four routes work.

## 4. Orchestration in `background.ts`

```
onCommand('trigger-huh') →
  if !armed(tab): arm(tab); toast; return
  sendMessage(content, {type:'PAUSE_AND_SHOW_CARD', status:'listening'})
  wav = await offscreen.getClip(seconds)
  if silent(wav): card.error('no speech'); return
  {transcript, detectedLang} = POST /api/transcribe
  card.update({transcript, detectedLang})
  [translation, explain] = await Promise.allSettled([
     POST /api/translate,
     POST /api/explain   // pass translation if already done, else transcript only
  ])
  card.update(...)
  remember transcript as previousTranscript for this tab (for context next time)
```

Get `videoTitle` from the content script: use `document.title`, minus the " - YouTube" suffix, or `ytd-watch-metadata h1` on YouTube.

## 5. Card UI (`content.ts`)

- Inject the card into a **Shadow DOM** root so the page's CSS can't break it. Max width 380px, fixed bottom-right, 16px offset, rounded corners, follows `prefers-color-scheme`.
- Sections: language chip (`HI → EN`), transcript (muted, original script), translation (bold), explanation, terms as `term — meaning` rows, and a button row.
- Show a skeleton shimmer per section while loading. Errors appear inline with a "Retry" link.
- Video control: `document.querySelector('video')`, choosing the largest visible one if several exist. Pause on open. Resume on close only if it was playing before. Replay sets `currentTime -= seconds` and plays.
- Fullscreen: if `document.fullscreenElement` is set, append the card host inside it so the card stays visible.
- Accessibility: focus the card on open, `Esc` closes, buttons have aria-labels.

## 6. Options page

Store these with `chrome.storage.sync`:
- **Target language**: the 22 Sarvam languages (`hi-IN, bn-IN, ta-IN, te-IN, kn-IN, ml-IN, mr-IN, gu-IN, pa-IN, od-IN, en-IN, as-IN, ur-IN, ne-IN, kok-IN, ks-IN, sd-IN, sa-IN, sat-IN, mni-IN, brx-IN, mai-IN, doi-IN`). Default: `en-IN`.
- **Translation style**: Formal (`sarvam-translate:v1`) or Colloquial / Code-mixed (`mayura:v1`).
- **Clip length**: 5–25s slider (default 12).
- **Voice**: dropdown of a few Bulbul speakers, plus an "Auto-play explanation audio" toggle.
- **Backend URL**: default `http://localhost:8787`.

## 7. Privacy and safety

- Audio lives only in the offscreen page's memory, as a 25s ring buffer. It's never written to disk and is sent only when the user triggers.
- The server doesn't log audio or transcripts by default. It logs only the request id, latency and status.
- Show a one-time onboarding page on install that explains this, plus a link to `chrome://extensions/shortcuts`.

## 8. Quality bar and done criteria

- `npm run build` in `extension/` produces a load-unpacked-ready `dist/`. `npm run dev` in `server/` starts on :8787.
- **Latency target:** transcript visible in under 2.5s, and the full card in under 5s, for a 12s clip on a normal connection. Log timings per stage on the card in dev mode.
- Works on YouTube (normal, theater and fullscreen), plus one non-YouTube site with an HTML5 `<video>` (e.g. Vimeo).
- Handles these cases cleanly: an unarmed tab, a silent clip, network failure, a Sarvam 4xx/5xx, a non-TTS target language, the tab closing while armed, and the service worker being restarted. Re-check whether the offscreen document exists before messaging it.
- Unit tests: the WAV encoder, ring-buffer slicing, and server route validation (mock Sarvam with `msw` or `nock`).
- README: setup with the env key, how to load the unpacked extension, the shortcut, the architecture diagram (ASCII is fine), and the Sarvam APIs used.

## 9. Sarvam API cheat sheet (where each one is used)

| Step | Sarvam API | Endpoint | Model | Called from |
|---|---|---|---|---|
| Transcribe | Speech-to-Text | `POST /speech-to-text` | `saaras:v4`, `mode=transcribe`, `language_code=unknown` | `server /api/transcribe` |
| (fast path) Speech→English | Speech-to-Text | `POST /speech-to-text` | `saaras:v4`, `mode=translate` | `server /api/transcribe` |
| Translate | Text Translate | `POST /translate` | `sarvam-translate:v1` (or `mayura:v1` for colloquial) | `server /api/translate` |
| Explain | Chat Completions | `POST /v1/chat/completions` | `sarvam-105b` | `server /api/explain` |
| Read aloud | Text-to-Speech | `POST /text-to-speech` | `bulbul:v4-flash` | `server /api/speak` |

Docs: https://docs.sarvam.ai (append `.md` to any page for raw markdown). API reference: https://docs.sarvam.ai/api-reference/introduction

Build in this order: server routes with curl tests → offscreen capture + ring buffer (log clip length, then save a WAV to verify) → background orchestration → card UI → options → SSE combined route → polish and tests.
