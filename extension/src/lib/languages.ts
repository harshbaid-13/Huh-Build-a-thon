export interface Language {
  code: string;
  name: string;
  native: string;
}

/** Sarvam's 22 scheduled Indian languages + Indian English. */
export const LANGUAGES: Language[] = [
  { code: 'en-IN', name: 'English', native: 'English' },
  { code: 'hi-IN', name: 'Hindi', native: 'हिन्दी' },
  { code: 'bn-IN', name: 'Bengali', native: 'বাংলা' },
  { code: 'ta-IN', name: 'Tamil', native: 'தமிழ்' },
  { code: 'te-IN', name: 'Telugu', native: 'తెలుగు' },
  { code: 'kn-IN', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ml-IN', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'mr-IN', name: 'Marathi', native: 'मराठी' },
  { code: 'gu-IN', name: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'pa-IN', name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'od-IN', name: 'Odia', native: 'ଓଡ଼ିଆ' },
  { code: 'as-IN', name: 'Assamese', native: 'অসমীয়া' },
  { code: 'ur-IN', name: 'Urdu', native: 'اردو' },
  { code: 'ne-IN', name: 'Nepali', native: 'नेपाली' },
  { code: 'kok-IN', name: 'Konkani', native: 'कोंकणी' },
  { code: 'ks-IN', name: 'Kashmiri', native: 'کٲشُر' },
  { code: 'sd-IN', name: 'Sindhi', native: 'سنڌي' },
  { code: 'sa-IN', name: 'Sanskrit', native: 'संस्कृतम्' },
  { code: 'sat-IN', name: 'Santali', native: 'ᱥᱟᱱᱛᱟᱲᱤ' },
  { code: 'mni-IN', name: 'Manipuri', native: 'মৈতৈলোন্' },
  { code: 'brx-IN', name: 'Bodo', native: 'बड़ो' },
  { code: 'mai-IN', name: 'Maithili', native: 'मैथिली' },
  { code: 'doi-IN', name: 'Dogri', native: 'डोगरी' },
];

/** Bulbul text-to-speech languages; the 🔊 button is hidden for the rest. */
export const TTS_LANGS = ['bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN'];

export function canSpeak(lang: string): boolean {
  return TTS_LANGS.includes(lang);
}

/** "hi-IN" → "HI" for the language chip. */
export function shortCode(lang: string | null | undefined): string {
  return lang ? lang.split('-')[0].toUpperCase() : '??';
}

/**
 * A few bulbul:v4-flash persona voices (v4-flash only accepts persona IDs — plain names like
 * "priya" return a 400). The voice speaks any TTS language; the suffix is its home style.
 */
export const VOICES: { id: string; label: string }[] = [
  { id: '', label: 'Default (Shubh, Hinglish)' },
  { id: 'simran_enhi_customer', label: 'Simran — Hinglish, friendly' },
  { id: 'ritu_hi_conversation', label: 'Ritu — Hindi, conversational' },
  { id: 'aditya_hi_conversational', label: 'Aditya — Hindi, conversational' },
  { id: 'shubh_en_narration', label: 'Shubh — English, narration' },
  { id: 'ishita_en_customer', label: 'Ishita — English, clear' },
  { id: 'gokul_ta_narration', label: 'Gokul — Tamil, narration' },
  { id: 'kavitha_te_conversation', label: 'Kavitha — Telugu, conversational' },
  { id: 'roopa_bn_conversational', label: 'Roopa — Bengali, conversational' },
];
