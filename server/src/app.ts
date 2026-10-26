import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ALL_LANGS, TTS_LANGS } from './languages.js';
import { SarvamError } from './sarvam.js';
import * as svc from './services.js';

export interface AppOptions {
  /** Comma-separated chrome-extension://<id> origins. Empty = allow any chrome-extension:// origin (dev). */
  allowedOrigin?: string;
  rateLimitPerMin?: number;
}

const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // 25s of 16 kHz 16-bit mono WAV is ~800 KB

const lang = z.enum(ALL_LANGS);
const sourceLang = z.union([lang, z.literal('unknown'), z.literal('auto')]);
const style = z.enum(['formal', 'colloquial', 'code-mixed']);

const translateSchema = z.object({
  text: z.string().trim().min(1).max(5000),
  sourceLang: sourceLang.nullish(),
  targetLang: lang,
  style: style.optional(),
});

const explainSchema = z.object({
  transcript: z.string().trim().min(1).max(5000),
  translation: z.string().max(5000).optional(),
  sourceLang: sourceLang.nullish(),
  targetLang: lang,
  videoTitle: z.string().max(500).optional(),
  pageUrl: z.string().max(2000).optional(),
  previousTranscript: z.string().max(5000).optional(),
});

const speakSchema = z.object({
  text: z.string().trim().min(1).max(2500),
  targetLang: z.enum(TTS_LANGS as [string, ...string[]]),
  speaker: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .max(64)
    .optional()
    .or(z.literal('')),
  pace: z.number().min(0.5).max(2).optional(),
});

class RequestError extends Error {
  constructor(
    public status: 400 | 413 | 429,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function errorBody(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (err instanceof RequestError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof SarvamError) {
    // A bad key is a server misconfiguration, not the client's fault.
    const status =
      err.status === 401 || err.status === 403
        ? 502
        : err.status === 429 || err.status === 422 || err.status === 400 || err.status === 504
          ? err.status
          : err.status >= 500
            ? 502
            : err.status;
    const message =
      err.status === 401 || err.status === 403
        ? 'The server’s Sarvam API key was rejected.'
        : err.status === 429
          ? 'Sarvam is rate-limiting us. Try again in a few seconds.'
          : err.message;
    return { status, body: { error: { code: err.code, message } } };
  }
  console.error('unhandled error:', (err as Error)?.stack ?? err);
  return { status: 500, body: { error: { code: 'internal_error', message: 'Something went wrong on the server.' } } };
}

function parseOr400<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new RequestError(400, 'invalid_request', msg);
  }
  return r.data;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new RequestError(400, 'invalid_json', 'Request body must be JSON.');
  }
}

/** Sliding-window limit keyed by the X-Huh-Install-Id header (falls back to the client address). */
function rateLimit(perMin: number): MiddlewareHandler {
  const hits = new Map<string, number[]>();
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const id = c.req.header('x-huh-install-id')?.slice(0, 64) || c.req.header('x-forwarded-for') || 'anon';
    const now = Date.now();
    const recent = (hits.get(id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMin) {
      c.header('retry-after', String(Math.ceil((60_000 - (now - recent[0])) / 1000)));
      throw new RequestError(429, 'rate_limited', 'Too many requests. Slow down a little.');
    }
    recent.push(now);
    hits.set(id, recent);
    if (hits.size > 10_000) hits.clear(); // crude memory bound
    await next();
  };
}

function parseKeyterms(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new RequestError(400, 'invalid_request', 'keyterms must be a JSON array of strings.');
  }
  if (!Array.isArray(arr)) throw new RequestError(400, 'invalid_request', 'keyterms must be a JSON array of strings.');
  return arr
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim().slice(0, 64))
    .slice(0, 50);
}

async function readAudioForm(c: Context) {
  const form = await c.req.parseBody();
  const audio = form['audio'];
  if (!(audio instanceof Blob) || audio.size === 0) {
    throw new RequestError(400, 'invalid_request', 'audio: a WAV file is required (multipart field "audio").');
  }
  return { form, audio };
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono();
  const allowed = (opts.allowedOrigin ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Metadata-only request log: never bodies, audio or transcripts.
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - started}ms`);
  });

  app.use(
    '/api/*',
    cors({
      origin: (origin) => {
        if (!origin) return null;
        if (allowed.length) return allowed.includes(origin) ? origin : null;
        return origin.startsWith('chrome-extension://') ? origin : null;
      },
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'x-huh-install-id'],
      maxAge: 600,
    }),
  );
  app.use('/api/*', rateLimit(opts.rateLimitPerMin ?? 30));

  const audioLimit = bodyLimit({
    maxSize: MAX_AUDIO_BYTES,
    onError: () => {
      throw new RequestError(413, 'audio_too_large', 'Audio clip is too large (max 2 MB / ~25 seconds).');
    },
  });

  app.onError((err, c) => {
    const { status, body } = errorBody(err);
    return c.json(body, status as any);
  });

  app.get('/health', (c) => c.json({ ok: true, hasKey: Boolean(process.env.SARVAM_API_KEY) }));

  // Route 1 — Speech-to-Text
  app.post('/api/transcribe', audioLimit, async (c) => {
    const { form, audio } = await readAudioForm(c);
    const src = parseOr400(sourceLang.optional(), form['sourceLang'] || undefined);
    const mode = parseOr400(z.enum(['transcribe', 'translate', 'codemix']).optional(), form['mode'] || undefined);
    const result = await svc.transcribe({ audio, sourceLang: src, mode, keyterms: parseKeyterms(form['keyterms']) });
    return c.json(result);
  });

  // Route 2 — Translate
  app.post('/api/translate', async (c) => {
    const input = parseOr400(translateSchema, await jsonBody(c));
    return c.json(await svc.translateText(input));
  });

  // Route 3 — Explain (Chat Completions)
  app.post('/api/explain', async (c) => {
    const input = parseOr400(explainSchema, await jsonBody(c));
    return c.json(await svc.explain(input));
  });

  // Route 4 — Text-to-Speech
  app.post('/api/speak', async (c) => {
    const input = parseOr400(speakSchema, await jsonBody(c));
    return c.json(await svc.speak({ ...input, speaker: input.speaker || undefined }));
  });

  // Combined route: transcribe → (translate ∥ explain), streamed as Server-Sent Events.
  app.post('/api/huh', audioLimit, async (c) => {
    const { form, audio } = await readAudioForm(c);
    const field = (k: string) => (typeof form[k] === 'string' && form[k] ? (form[k] as string) : undefined);
    const targetLang = parseOr400(lang, field('targetLang') ?? 'en-IN');
    const translationStyle = parseOr400(style.optional(), field('style'));
    const src = parseOr400(sourceLang.optional(), field('sourceLang'));
    const keyterms = parseKeyterms(form['keyterms']);

    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      const sendError = (stage: string, err: unknown) => send('error', { stage, ...errorBody(err).body.error });

      // Fast path for English targets: saaras mode=translate gives speech→English in one hop,
      // run alongside the original-language transcript instead of a separate /translate call.
      const englishFast =
        targetLang === 'en-IN' ? svc.transcribe({ audio, sourceLang: src, mode: 'translate' }) : null;
      englishFast?.catch(() => {}); // handled below; avoid an unhandled rejection if transcribe fails first

      let t: svc.TranscribeResult;
      try {
        t = await svc.transcribe({ audio, sourceLang: src, keyterms });
      } catch (err) {
        await sendError('transcript', err);
        return;
      }
      await send('transcript', t);
      if (!t.transcript) {
        await send('done', {});
        return;
      }

      const translation = async (): Promise<svc.TranslateResult> => {
        if (englishFast && t.detectedLang !== 'en-IN') {
          const fast = await englishFast.catch(() => null);
          if (fast?.transcript) {
            return { translatedText: fast.transcript, sourceLang: t.detectedLang, model: null, skipped: false };
          }
        }
        return svc.translateText({ text: t.transcript, sourceLang: t.detectedLang, targetLang, style: translationStyle });
      };

      await Promise.allSettled([
        translation().then((r) => send('translation', r), (err) => sendError('translation', err)),
        svc
          .explain({
            transcript: t.transcript,
            sourceLang: t.detectedLang,
            targetLang,
            videoTitle: field('videoTitle'),
            pageUrl: field('pageUrl'),
            previousTranscript: field('previousTranscript'),
          })
          .then((r) => send('explanation', r), (err) => sendError('explanation', err)),
      ]);
      await send('done', {});
    });
  });

  return app;
}
