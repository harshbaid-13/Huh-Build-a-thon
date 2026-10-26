// Message shapes between background ⇄ offscreen ⇄ content.

export interface Term {
  term: string;
  meaning: string;
}

export interface Explanation {
  explanation: string;
  terms: Term[];
}

export type SectionState<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; value: T }
  | { state: 'error'; error: string };

export type SectionName = 'transcript' | 'translation' | 'explanation';

export interface CardState {
  runId: number;
  clipSeconds: number;
  /** Top-level status line, e.g. "Listening back 12s…" or a whole-card error. */
  status: { kind: 'working' | 'error' | 'done'; text?: string };
  sourceLang: string | null;
  targetLang: string;
  canSpeak: boolean;
  transcript: SectionState<string>;
  translation: SectionState<string>;
  explanation: SectionState<Explanation>;
  speech: 'idle' | 'loading' | 'playing' | 'error';
  speechError?: string;
  /** Per-stage latency in ms, shown only in dev mode. */
  timings?: Record<string, number>;
}

// background → content
export type ContentMessage =
  | { type: 'HUH_PING' }
  | { type: 'HUH_TOAST'; text: string }
  | { type: 'HUH_OPEN_CARD'; card: CardState }
  | { type: 'HUH_PATCH_CARD'; runId: number; patch: Partial<CardState> }
  | { type: 'HUH_PAGE_INFO' };

export interface PageInfo {
  title: string;
  url: string;
}

// content → background
export type BackgroundMessage =
  | { type: 'HUH_SPEAK'; runId: number }
  | { type: 'HUH_STOP_SPEECH' }
  | { type: 'HUH_RETRY'; runId: number; section: SectionName }
  | { type: 'HUH_CARD_CLOSED'; runId: number }
  | { type: 'HUH_OPEN_OPTIONS' };

// background ⇄ offscreen (always tagged with target)
export type OffscreenRequest =
  | { target: 'offscreen'; type: 'START'; streamId: string; tabId: number }
  | { target: 'offscreen'; type: 'STOP' }
  | { target: 'offscreen'; type: 'STATUS' }
  | { target: 'offscreen'; type: 'GET_CLIP'; seconds: number }
  | { target: 'offscreen'; type: 'PLAY_AUDIO'; audio: string; mimeType: string }
  | { target: 'offscreen'; type: 'STOP_AUDIO' };

export interface OffscreenStatus {
  capturing: boolean;
  tabId: number | null;
  bufferedSeconds: number;
}

export type ClipResult =
  | { ok: true; wav: string; seconds: number; rms: number }
  | { ok: false; error: string };

// offscreen → background (events)
export type OffscreenEvent =
  | { target: 'background'; type: 'CAPTURE_ENDED'; tabId: number | null }
  | { target: 'background'; type: 'AUDIO_ENDED' };
