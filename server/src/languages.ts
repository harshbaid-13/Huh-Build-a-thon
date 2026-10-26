// The 22 scheduled Indian languages + Indian English, as Sarvam language codes.
export const ALL_LANGS = [
  'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'gu-IN', 'pa-IN', 'od-IN', 'en-IN',
  'as-IN', 'ur-IN', 'ne-IN', 'kok-IN', 'ks-IN', 'sd-IN', 'sa-IN', 'sat-IN', 'mni-IN', 'brx-IN',
  'mai-IN', 'doi-IN',
] as const;

/** Bulbul TTS and Mayura translation both cover these 11. */
export const CORE_LANGS = [
  'bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
] as const;

export const TTS_LANGS: readonly string[] = CORE_LANGS;
export const MAYURA_LANGS: readonly string[] = CORE_LANGS;

export function isLang(code: string): boolean {
  return (ALL_LANGS as readonly string[]).includes(code);
}

export const LANG_NAMES: Record<string, string> = {
  'hi-IN': 'Hindi', 'bn-IN': 'Bengali', 'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam', 'mr-IN': 'Marathi', 'gu-IN': 'Gujarati', 'pa-IN': 'Punjabi', 'od-IN': 'Odia',
  'en-IN': 'English', 'as-IN': 'Assamese', 'ur-IN': 'Urdu', 'ne-IN': 'Nepali', 'kok-IN': 'Konkani',
  'ks-IN': 'Kashmiri', 'sd-IN': 'Sindhi', 'sa-IN': 'Sanskrit', 'sat-IN': 'Santali', 'mni-IN': 'Manipuri',
  'brx-IN': 'Bodo', 'mai-IN': 'Maithili', 'doi-IN': 'Dogri',
};

/** Native-script text with Latin words mixed in, e.g. "ये तो बेकार plan है". */
export function isCodeMixed(text: string): boolean {
  return /[A-Za-z]{2,}/.test(text) && /[^\u0000-ɏ\s\p{P}\p{N}]/u.test(text);
}
