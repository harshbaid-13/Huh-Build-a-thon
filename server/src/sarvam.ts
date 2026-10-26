// One typed wrapper per Sarvam API. Plain fetch, 15s timeout, typed errors.
// Reference: https://docs.sarvam.ai/api-reference/introduction

export const SARVAM_BASE_URL = 'https://api.sarvam.ai';
const TIMEOUT_MS = 15_000;

export class SarvamError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'SarvamError';
  }
}

function apiKey(): string {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new SarvamError(500, 'missing_api_key', 'SARVAM_API_KEY is not set on the server');
  return key;
}

async function call<T>(path: string, init: { body: BodyInit; json?: boolean }): Promise<T> {
  const headers: Record<string, string> = { 'api-subscription-key': apiKey() };
  if (init.json) headers['content-type'] = 'application/json';

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(SARVAM_BASE_URL + path, {
      method: 'POST',
      headers,
      body: init.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SarvamError(504, 'timeout', `Sarvam ${path} timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw new SarvamError(502, 'network_error', `Could not reach Sarvam: ${(err as Error).message}`);
  }

  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const requestId: string | undefined = body?.request_id ?? body?.error?.request_id ?? body?.id;
  // Log only metadata — never audio, transcripts or keys.
  console.log(`sarvam ${path} ${res.status} ${Date.now() - started}ms req=${requestId ?? '-'}`);

  if (!res.ok) {
    const err = body?.error ?? body?.detail ?? body;
    const message =
      typeof err === 'string' ? err : err?.message ?? (text.slice(0, 300) || res.statusText);
    const short = message.length > 300 ? message.slice(0, 300) + '…' : message;
    throw new SarvamError(res.status, err?.code ?? 'sarvam_error', short, requestId);
  }
  return body as T;
}

// ---------- Speech-to-Text (Saaras) ----------

export type SttMode = 'transcribe' | 'translate' | 'verbatim' | 'translit' | 'codemix';

export interface SpeechToTextParams {
  audio: Blob;
  filename?: string;
  model?: 'saaras:v4' | 'saaras:v3';
  mode?: SttMode;
  /** BCP-47 code, or "unknown" to auto-detect. */
  languageCode?: string;
  /** Up to 50 bias terms; saaras:v4 only. */
  keyterms?: string[];
}

export interface SpeechToTextResponse {
  request_id: string | null;
  transcript: string;
  language_code: string | null;
  language_probability?: number | null;
}

export function speechToText(p: SpeechToTextParams): Promise<SpeechToTextResponse> {
  const form = new FormData();
  form.append('file', p.audio, p.filename ?? 'clip.wav');
  form.append('model', p.model ?? 'saaras:v4');
  form.append('mode', p.mode ?? 'transcribe');
  form.append('language_code', p.languageCode ?? 'unknown');
  if (p.keyterms?.length) form.append('keyterms', JSON.stringify(p.keyterms.slice(0, 50)));
  return call('/speech-to-text', { body: form });
}

// ---------- Text translation (Sarvam-Translate / Mayura) ----------

export type TranslateModel = 'sarvam-translate:v1' | 'mayura:v1';
export type TranslateMode = 'formal' | 'modern-colloquial' | 'classic-colloquial' | 'code-mixed';

export interface TranslateParams {
  input: string;
  sourceLanguageCode: string;
  targetLanguageCode: string;
  model: TranslateModel;
  mode?: TranslateMode;
}

export interface TranslateResponse {
  request_id: string | null;
  translated_text: string;
  source_language_code: string;
}

export function translate(p: TranslateParams): Promise<TranslateResponse> {
  return call('/translate', {
    json: true,
    body: JSON.stringify({
      input: p.input,
      source_language_code: p.sourceLanguageCode,
      target_language_code: p.targetLanguageCode,
      model: p.model,
      mode: p.mode ?? 'formal',
    }),
  });
}

// ---------- Chat Completions (Sarvam-105B) ----------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model?: 'sarvam-105b' | 'sarvam-105b-conversations';
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** null disables thinking (keeps latency low and stops reasoning eating max_tokens). */
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
  responseFormat?:
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: { name: string; schema: object; strict?: boolean } };
}

export interface ChatResponse {
  id: string;
  choices: { message: { role: string; content: string | null }; finish_reason: string }[];
}

export function chatCompletion(p: ChatParams): Promise<ChatResponse> {
  return call('/v1/chat/completions', {
    json: true,
    body: JSON.stringify({
      model: p.model ?? 'sarvam-105b',
      messages: p.messages,
      max_tokens: p.maxTokens ?? 400,
      temperature: p.temperature ?? 0.3,
      reasoning_effort: p.reasoningEffort === undefined ? null : p.reasoningEffort,
      ...(p.responseFormat ? { response_format: p.responseFormat } : {}),
    }),
  });
}

// ---------- Text-to-Speech (Bulbul) ----------

export interface TextToSpeechParams {
  text: string;
  /** Field is language_code (not target_language_code). */
  languageCode: string;
  model?: 'bulbul:v4-flash' | 'bulbul:v3';
  speaker?: string;
  pace?: number;
  sampleRate?: number;
  codec?: 'mp3' | 'wav';
}

export interface TextToSpeechResponse {
  request_id: string | null;
  audios: string[];
}

export function textToSpeech(p: TextToSpeechParams): Promise<TextToSpeechResponse> {
  return call('/text-to-speech', {
    json: true,
    body: JSON.stringify({
      text: p.text,
      language_code: p.languageCode,
      model: p.model ?? 'bulbul:v4-flash',
      ...(p.speaker ? { speaker: p.speaker } : {}),
      pace: p.pace ?? 1.0,
      speech_sample_rate: p.sampleRate ?? 24000,
      output_audio_codec: p.codec ?? 'mp3',
    }),
  });
}
