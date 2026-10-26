// Business logic shared by the individual routes and the combined SSE route.
import { LANG_NAMES, MAYURA_LANGS, isCodeMixed, isLang } from './languages.js';
import * as sarvam from './sarvam.js';
import { SarvamError } from './sarvam.js';

// ---------- transcribe ----------

export interface TranscribeInput {
  audio: Blob;
  sourceLang?: string; // BCP-47 or "unknown"
  mode?: 'transcribe' | 'translate' | 'codemix';
  keyterms?: string[];
}

export interface TranscribeResult {
  transcript: string;
  detectedLang: string | null;
  languageProbability: number | null;
}

export async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
  try {
    const res = await sarvam.speechToText({
      audio: input.audio,
      model: 'saaras:v4',
      // Deviation from BUILD_PROMPT ("mode: transcribe"): with language_code=unknown, saaras:v4
      // in "transcribe" mode misdetected Hindi/Hinglish speech as en-IN and romanized it in our
      // tests, while "codemix" detected hi-IN (p≈0.98) and kept the original script — with English
      // words left in English, which is how Indian videos are actually spoken. Tamil and English
      // clips came out identical in both modes, so codemix is the default.
      mode: input.mode ?? 'codemix',
      languageCode: input.sourceLang && input.sourceLang !== 'auto' ? input.sourceLang : 'unknown',
      keyterms: input.keyterms,
    });
    return {
      transcript: (res.transcript ?? '').trim(),
      detectedLang: res.language_code ?? null,
      languageProbability: res.language_probability ?? null,
    };
  } catch (err) {
    if (err instanceof SarvamError && err.status === 422) {
      throw new SarvamError(
        422,
        'bad_audio',
        "That clip couldn't be processed (unsupported format or longer than 30 seconds).",
        err.requestId,
      );
    }
    throw err;
  }
}

// ---------- translate ----------

export type TranslationStyle = 'formal' | 'colloquial' | 'code-mixed';

export interface TranslateInput {
  text: string;
  sourceLang?: string | null;
  targetLang: string;
  style?: TranslationStyle;
}

export interface TranslateResult {
  translatedText: string;
  sourceLang: string | null;
  model: sarvam.TranslateModel | null;
  skipped: boolean;
}

const LIMITS: Record<sarvam.TranslateModel, number> = { 'sarvam-translate:v1': 2000, 'mayura:v1': 1000 };

export async function translateText(input: TranslateInput): Promise<TranslateResult> {
  const source = input.sourceLang && isLang(input.sourceLang) ? input.sourceLang : null;
  if (source === input.targetLang) {
    return { translatedText: input.text, sourceLang: source, model: null, skipped: true };
  }

  const style = input.style ?? 'formal';
  const mayuraOk = MAYURA_LANGS.includes(input.targetLang) && (!source || MAYURA_LANGS.includes(source));
  // sarvam-translate:v1 needs an explicit source language (it rejects "auto" with a 400), and in
  // our tests it badly mistranslated code-mixed input ("ये तो बेकार plan है" → unrelated sentence)
  // while Mayura handled it well. So Mayura is used for colloquial styles, unknown sources and
  // code-mixed text; sarvam-translate:v1 (all 22 languages) for everything else.
  const useMayura = mayuraOk && (style !== 'formal' || !source || isCodeMixed(input.text));
  if (!useMayura && !source) {
    throw new SarvamError(422, 'unknown_source_language', "Couldn't tell which language was spoken.");
  }

  const model: sarvam.TranslateModel = useMayura ? 'mayura:v1' : 'sarvam-translate:v1';
  const mode: sarvam.TranslateMode = !useMayura
    ? 'formal' // sarvam-translate:v1 only supports formal
    : style === 'code-mixed'
      ? 'code-mixed'
      : style === 'colloquial'
        ? 'modern-colloquial'
        : 'formal';

  const res = await sarvam.translate({
    input: input.text.slice(0, LIMITS[model]),
    sourceLanguageCode: source ?? 'auto',
    targetLanguageCode: input.targetLang,
    model,
    mode,
  });
  return {
    translatedText: res.translated_text,
    sourceLang: res.source_language_code ?? source,
    model,
    skipped: false,
  };
}

// ---------- explain ----------

export interface ExplainInput {
  transcript: string;
  translation?: string;
  sourceLang?: string | null;
  targetLang: string;
  videoTitle?: string;
  pageUrl?: string;
  previousTranscript?: string;
}

export interface Term {
  term: string;
  meaning: string;
}

export interface ExplainResult {
  explanation: string;
  terms: Term[];
}

export function langName(code: string): string {
  return LANG_NAMES[code] ? `${LANG_NAMES[code]} (${code})` : code;
}

export function systemPrompt(targetLang: string): string {
  // The spec says "Write in language {targetLang}"; with a bare code like hi-IN the model kept
  // answering in English, so the language is named and its native script required.
  return `You help someone who just missed a line in a video. Reply ONLY with JSON:
{"explanation": string, "terms": [{"term": string, "meaning": string}]}
- Write "explanation" and every "meaning" in ${langName(targetLang)}, in its native script.
- "explanation": 1–3 short sentences, plain words, saying what the speaker meant
  in context. Do not repeat the translation verbatim. If the clip starts or ends
  mid-sentence, infer gently and say so.
- "terms": up to 3 jargon/slang/idioms/names from the clip that a listener might
  not know. Empty array if none.
- Never invent facts beyond the clip and the provided context.`;
}

function domainOf(url?: string): string {
  if (!url) return 'unknown';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

export function userPrompt(input: ExplainInput): string {
  const lines = [
    `Video title: ${input.videoTitle?.trim() || 'unknown'}`,
    `Site: ${domainOf(input.pageUrl)}`,
  ];
  if (input.previousTranscript?.trim()) lines.push(`Previous clip (for context): ${input.previousTranscript.trim()}`);
  lines.push(`Clip transcript (${input.sourceLang ?? 'unknown language'}): ${input.transcript}`);
  if (input.translation?.trim()) lines.push(`Translation (${input.targetLang}): ${input.translation.trim()}`);
  lines.push(`Answer in ${langName(input.targetLang)}.`);
  return lines.join('\n');
}

// The docs recommend json_schema (Structured Outputs) over json_object; it works with
// reasoning disabled and makes the parse-retry path rarely needed.
const EXPLAIN_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'huh_explanation',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        explanation: { type: 'string' },
        terms: {
          type: 'array',
          items: {
            type: 'object',
            properties: { term: { type: 'string' }, meaning: { type: 'string' } },
            required: ['term', 'meaning'],
            additionalProperties: false,
          },
        },
      },
      required: ['explanation', 'terms'],
      additionalProperties: false,
    },
  },
};

export function parseExplanation(content: string): ExplainResult | null {
  const raw = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const obj = JSON.parse(raw);
    if (typeof obj?.explanation !== 'string') return null;
    const terms: Term[] = Array.isArray(obj.terms)
      ? obj.terms
          .filter((t: any) => typeof t?.term === 'string' && typeof t?.meaning === 'string')
          .slice(0, 3)
      : [];
    return { explanation: obj.explanation.trim(), terms };
  } catch {
    return null;
  }
}

export async function explain(input: ExplainInput): Promise<ExplainResult> {
  const messages: sarvam.ChatMessage[] = [
    { role: 'system', content: systemPrompt(input.targetLang) },
    { role: 'user', content: userPrompt(input) },
  ];
  let lastContent = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await sarvam.chatCompletion({
      model: 'sarvam-105b',
      messages,
      maxTokens: 400,
      temperature: 0.3,
      reasoningEffort: null,
      responseFormat: EXPLAIN_SCHEMA,
    });
    lastContent = res.choices?.[0]?.message?.content ?? '';
    const parsed = parseExplanation(lastContent);
    if (parsed) return parsed;
  }
  return { explanation: lastContent.trim(), terms: [] };
}

// ---------- speak ----------

export interface SpeakInput {
  text: string;
  targetLang: string;
  speaker?: string;
  pace?: number;
}

export async function speak(input: SpeakInput): Promise<{ audio: string; mimeType: 'audio/mpeg' }> {
  const res = await sarvam.textToSpeech({
    text: input.text.slice(0, 2500),
    languageCode: input.targetLang,
    model: 'bulbul:v4-flash',
    speaker: input.speaker || undefined,
    pace: input.pace ?? 1.0,
    sampleRate: 24000,
    codec: 'mp3',
  });
  // Each element is a separate base64 MP3; decode and join the bytes (MP3 frames concatenate).
  const bytes = Buffer.concat(res.audios.map((a) => Buffer.from(a, 'base64')));
  return { audio: bytes.toString('base64'), mimeType: 'audio/mpeg' };
}
