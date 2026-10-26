import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { isCodeMixed } from '../src/languages.js';
import { parseExplanation } from '../src/services.js';

const SARVAM = 'https://api.sarvam.ai';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const calls: { path: string; body: any }[] = [];
const sarvam = setupServer(
  http.post(`${SARVAM}/speech-to-text`, async ({ request }) => {
    const form = await request.formData();
    calls.push({ path: '/speech-to-text', body: Object.fromEntries([...form.entries()].filter(([k]) => k !== 'file')) });
    const translate = form.get('mode') === 'translate';
    return HttpResponse.json({
      request_id: 'stt-1',
      transcript: translate ? 'This plan is useless.' : 'ये तो बेकार plan है',
      language_code: 'hi-IN',
      language_probability: 0.98,
    });
  }),
  http.post(`${SARVAM}/translate`, async ({ request }) => {
    const body = await request.json();
    calls.push({ path: '/translate', body });
    return HttpResponse.json({ request_id: 'tr-1', translated_text: 'TRANSLATED', source_language_code: 'hi-IN' });
  }),
  http.post(`${SARVAM}/v1/chat/completions`, async ({ request }) => {
    const body = await request.json();
    calls.push({ path: '/v1/chat/completions', body });
    return HttpResponse.json({
      id: 'chat-1',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify({ explanation: 'They think the plan is bad.', terms: [] }) },
        },
      ],
    });
  }),
  http.post(`${SARVAM}/text-to-speech`, async ({ request }) => {
    const body = await request.json();
    calls.push({ path: '/text-to-speech', body });
    return HttpResponse.json({ request_id: 'tts-1', audios: [Buffer.from('AB').toString('base64'), Buffer.from('CD').toString('base64')] });
  }),
);

beforeAll(() => {
  process.env.SARVAM_API_KEY = 'test-key';
  sarvam.listen();
});
beforeEach(() => {
  calls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  sarvam.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => sarvam.close());

let installCounter = 0;
function app(opts: Parameters<typeof createApp>[0] = {}) {
  return createApp({ allowedOrigin: ORIGIN, ...opts });
}
function headers(extra: Record<string, string> = {}) {
  return { origin: ORIGIN, 'x-huh-install-id': `install-${++installCounter}`, ...extra };
}
function postJson(a: ReturnType<typeof createApp>, path: string, body: unknown) {
  return a.request(path, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}
function wavForm(fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(64)], { type: 'audio/wav' }), 'clip.wav');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

describe('POST /api/transcribe', () => {
  it('rejects a request without audio', async () => {
    const res = await app().request('/api/transcribe', { method: 'POST', headers: headers(), body: new FormData() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_request');
  });

  it('rejects an unknown source language', async () => {
    const res = await app().request('/api/transcribe', {
      method: 'POST',
      headers: headers(),
      body: wavForm({ sourceLang: 'xx-YY' }),
    });
    expect(res.status).toBe(400);
  });

  it('transcribes with saaras:v4 and auto-detect', async () => {
    const res = await app().request('/api/transcribe', {
      method: 'POST',
      headers: headers(),
      body: wavForm({ keyterms: JSON.stringify(['Shark Tank']) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ transcript: 'ये तो बेकार plan है', detectedLang: 'hi-IN', languageProbability: 0.98 });
    expect(calls[0].body).toMatchObject({ model: 'saaras:v4', language_code: 'unknown', keyterms: '["Shark Tank"]' });
  });

  it('maps a Sarvam 422 to a friendly message', async () => {
    sarvam.use(http.post(`${SARVAM}/speech-to-text`, () => HttpResponse.json({ error: { message: 'too long' } }, { status: 422 })));
    const res = await app().request('/api/transcribe', { method: 'POST', headers: headers(), body: wavForm() });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/longer than 30 seconds/);
  });

  it('maps a Sarvam 5xx to 502', async () => {
    sarvam.use(http.post(`${SARVAM}/speech-to-text`, () => HttpResponse.text('boom', { status: 503 })));
    const res = await app().request('/api/transcribe', { method: 'POST', headers: headers(), body: wavForm() });
    expect(res.status).toBe(502);
  });

  it('hides a rejected API key behind a 502', async () => {
    sarvam.use(http.post(`${SARVAM}/speech-to-text`, () => HttpResponse.json({ error: { message: 'bad key' } }, { status: 403 })));
    const res = await app().request('/api/transcribe', { method: 'POST', headers: headers(), body: wavForm() });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/API key/);
  });
});

describe('POST /api/translate', () => {
  it('validates the body', async () => {
    expect((await postJson(app(), '/api/translate', { text: '', targetLang: 'hi-IN' })).status).toBe(400);
    expect((await postJson(app(), '/api/translate', { text: 'hi', targetLang: 'fr-FR' })).status).toBe(400);
    const bad = await app().request('/api/translate', { method: 'POST', headers: headers(), body: 'not json' });
    expect(bad.status).toBe(400);
  });

  it('skips the call when languages are equal', async () => {
    const res = await postJson(app(), '/api/translate', { text: 'hello', sourceLang: 'en-IN', targetLang: 'en-IN' });
    expect(await res.json()).toMatchObject({ translatedText: 'hello', skipped: true });
    expect(calls).toHaveLength(0);
  });

  it('uses sarvam-translate:v1 for plain text', async () => {
    await postJson(app(), '/api/translate', { text: 'Hello there friend', sourceLang: 'en-IN', targetLang: 'hi-IN' });
    expect(calls[0].body).toMatchObject({ model: 'sarvam-translate:v1', mode: 'formal', source_language_code: 'en-IN' });
  });

  it('uses mayura:v1 for code-mixed text and colloquial style', async () => {
    await postJson(app(), '/api/translate', { text: 'ये तो बेकार plan है', sourceLang: 'hi-IN', targetLang: 'en-IN' });
    expect(calls[0].body).toMatchObject({ model: 'mayura:v1' });
    await postJson(app(), '/api/translate', { text: 'नमस्ते दोस्त', sourceLang: 'hi-IN', targetLang: 'en-IN', style: 'code-mixed' });
    expect(calls[1].body).toMatchObject({ model: 'mayura:v1', mode: 'code-mixed' });
  });

  it('falls back to mayura auto-detect when the source is unknown', async () => {
    await postJson(app(), '/api/translate', { text: 'नमस्ते', sourceLang: 'unknown', targetLang: 'en-IN' });
    expect(calls[0].body).toMatchObject({ model: 'mayura:v1', source_language_code: 'auto' });
  });
});

describe('POST /api/explain', () => {
  it('validates the body', async () => {
    expect((await postJson(app(), '/api/explain', { targetLang: 'en-IN' })).status).toBe(400);
  });

  it('calls sarvam-105b with reasoning disabled and structured output', async () => {
    const res = await postJson(app(), '/api/explain', {
      transcript: 'ये तो बेकार plan है',
      sourceLang: 'hi-IN',
      targetLang: 'en-IN',
      videoTitle: 'Shark Tank',
      pageUrl: 'https://www.youtube.com/watch?v=1',
    });
    expect(await res.json()).toEqual({ explanation: 'They think the plan is bad.', terms: [] });
    const body = calls[0].body;
    expect(body).toMatchObject({ model: 'sarvam-105b', reasoning_effort: null, max_tokens: 400, temperature: 0.3 });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[1].content).toContain('Site: youtube.com');
  });

  it('retries once on unparseable output, then falls back to raw content', async () => {
    sarvam.use(
      http.post(`${SARVAM}/v1/chat/completions`, () =>
        HttpResponse.json({ id: 'x', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'not json' } }] }),
      ),
    );
    let n = 0;
    sarvam.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/v1/chat/completions')) n++;
    });
    const res = await postJson(app(), '/api/explain', { transcript: 'hello', targetLang: 'en-IN' });
    expect(await res.json()).toEqual({ explanation: 'not json', terms: [] });
    expect(n).toBe(2);
    sarvam.events.removeAllListeners();
  });
});

describe('POST /api/speak', () => {
  it('rejects non-TTS languages and bad speakers', async () => {
    expect((await postJson(app(), '/api/speak', { text: 'x', targetLang: 'as-IN' })).status).toBe(400);
    expect((await postJson(app(), '/api/speak', { text: 'x', targetLang: 'en-IN', speaker: 'Bad Name!' })).status).toBe(400);
  });

  it('returns joined mp3 bytes as base64', async () => {
    const res = await postJson(app(), '/api/speak', { text: 'hello', targetLang: 'en-IN', speaker: 'shubh_en_narration' });
    const json = await res.json();
    expect(Buffer.from(json.audio, 'base64').toString()).toBe('ABCD');
    expect(calls[0].body).toMatchObject({ language_code: 'en-IN', model: 'bulbul:v4-flash', output_audio_codec: 'mp3' });
  });
});

describe('POST /api/huh (SSE)', () => {
  it('streams transcript, translation and explanation events', async () => {
    const res = await app().request('/api/huh', { method: 'POST', headers: headers(), body: wavForm({ targetLang: 'en-IN' }) });
    const text = await res.text();
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe('transcript');
    expect(events).toEqual(expect.arrayContaining(['translation', 'explanation', 'done']));
    // English target uses the STT translate fast path, not /translate.
    expect(text).toContain('This plan is useless.');
    expect(calls.some((c) => c.path === '/translate')).toBe(false);
  });
});

describe('middleware', () => {
  it('only allows the configured extension origin', async () => {
    const ok = await app().request('/api/explain', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const bad = await app().request('/api/explain', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate-limits per install id', async () => {
    const a = app({ rateLimitPerMin: 2 });
    const h = { ...headers(), 'content-type': 'application/json', 'x-huh-install-id': 'same' };
    const body = JSON.stringify({ text: 'hi', sourceLang: 'en-IN', targetLang: 'en-IN' });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await a.request('/api/translate', { method: 'POST', headers: h, body })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe('helpers', () => {
  it('parses explanations, including fenced JSON', () => {
    expect(parseExplanation('```json\n{"explanation":"x","terms":[{"term":"a","meaning":"b"}]}\n```')).toEqual({
      explanation: 'x',
      terms: [{ term: 'a', meaning: 'b' }],
    });
    expect(parseExplanation('{"terms":[]}')).toBeNull();
  });

  it('detects code-mixed text', () => {
    expect(isCodeMixed('ये तो बेकार plan है')).toBe(true);
    expect(isCodeMixed('ये तो बेकार योजना है')).toBe(false);
    expect(isCodeMixed('This is plain English.')).toBe(false);
  });
});
