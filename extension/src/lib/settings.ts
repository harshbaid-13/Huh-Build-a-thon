export type TranslationStyle = 'formal' | 'colloquial' | 'code-mixed';

export interface Settings {
  targetLang: string;
  style: TranslationStyle;
  clipSeconds: number;
  speaker: string;
  autoPlay: boolean;
  backendUrl: string;
  devMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  targetLang: 'en-IN',
  style: 'formal',
  clipSeconds: 12,
  speaker: '',
  autoPlay: false,
  backendUrl: 'http://localhost:8787',
  devMode: false,
};

export const MIN_CLIP_SECONDS = 5;
export const MAX_CLIP_SECONDS = 25;

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Partial<Settings>;
  const s = { ...DEFAULT_SETTINGS, ...stored };
  s.clipSeconds = Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.round(Number(s.clipSeconds) || 12)));
  s.backendUrl = (s.backendUrl || DEFAULT_SETTINGS.backendUrl).replace(/\/+$/, '');
  return s;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

/** Random id generated once per install, sent as X-Huh-Install-Id for server rate limiting. */
export async function getInstallId(): Promise<string> {
  const { installId } = (await chrome.storage.local.get('installId')) as { installId?: string };
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}
