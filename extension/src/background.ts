// Service worker: commands, tab capture, orchestration of the Huh? pipeline.
import { SILENCE_RMS, base64ToBytes } from './lib/audio';
import { canSpeak } from './lib/languages';
import type {
  BackgroundMessage,
  CardState,
  ClipResult,
  ContentMessage,
  Explanation,
  OffscreenEvent,
  OffscreenRequest,
  OffscreenStatus,
  PageInfo,
  SectionName,
} from './lib/messages';
import { getInstallId, getSettings, type Settings } from './lib/settings';

const OFFSCREEN_PATH = 'offscreen.html';
const BADGE_COLOR = '#16a34a';

// ---------------------------------------------------------------- armed-tab state
// Persisted in storage.session so a service-worker restart doesn't forget the armed tab.
// The offscreen document (which owns the stream) is the source of truth; see currentArmed().

interface Armed {
  tabId: number;
  origin: string;
}

async function loadArmed(): Promise<Armed | null> {
  const { armed } = (await chrome.storage.session.get('armed')) as { armed?: Armed };
  return armed ?? null;
}

async function saveArmed(armed: Armed | null) {
  if (armed) await chrome.storage.session.set({ armed });
  else await chrome.storage.session.remove('armed');
}

async function setBadge(tabId: number, on: boolean) {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' }).catch(() => {});
  await chrome.action
    .setTitle({ tabId, title: on ? 'Huh? is listening — click to stop' : 'Huh? — click to start listening' })
    .catch(() => {});
}

// ---------------------------------------------------------------- offscreen document

let creatingOffscreen: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Buffer tab audio for on-demand transcription',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

type OffscreenPayload = OffscreenRequest extends infer R ? (R extends { target: 'offscreen' } ? Omit<R, 'target'> : never) : never;

async function toOffscreen<T>(msg: OffscreenPayload): Promise<T> {
  // Re-check the document exists before every message: it may be gone after a SW restart.
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

async function offscreenStatus(): Promise<OffscreenStatus> {
  if (!(await hasOffscreen())) return { capturing: false, tabId: null, bufferedSeconds: 0 };
  return toOffscreen<OffscreenStatus>({ type: 'STATUS' });
}

/** The armed tab, verified against the offscreen document that actually holds the stream. */
async function currentArmed(): Promise<Armed | null> {
  const armed = await loadArmed();
  const status = await offscreenStatus().catch(() => null);
  if (armed && status?.capturing && status.tabId === armed.tabId) return armed;
  if (armed) {
    await saveArmed(null);
    await setBadge(armed.tabId, false);
  }
  return null;
}

// ---------------------------------------------------------------- content script

async function ensureContent(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'HUH_PING' } satisfies ContentMessage);
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch (err) {
      console.warn('Huh?: cannot inject into tab', tabId, err);
      return false;
    }
  }
}

async function toContent<T = unknown>(tabId: number, msg: ContentMessage): Promise<T | undefined> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return undefined;
  }
}

async function toast(tabId: number, text: string) {
  if (await ensureContent(tabId)) await toContent(tabId, { type: 'HUH_TOAST', text });
}

async function shortcutLabel(): Promise<string> {
  const cmds = await chrome.commands.getAll();
  return cmds.find((c) => c.name === 'trigger-huh')?.shortcut || 'the Huh? shortcut';
}

// ---------------------------------------------------------------- arm / disarm

function originOf(url?: string): string | null {
  if (!url || !/^https?:/.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function arm(tab: chrome.tabs.Tab): Promise<boolean> {
  const tabId = tab.id!;
  const origin = originOf(tab.url);
  if (!origin) {
    await setBadge(tabId, false);
    await chrome.action.setTitle({ tabId, title: 'Huh? works on normal web pages (http/https) only' }).catch(() => {});
    return false;
  }

  const previous = await loadArmed();
  let streamId: string;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    // e.g. "Cannot capture a tab with an active stream" — stop whatever holds it and retry once.
    await toOffscreen({ type: 'STOP' }).catch(() => {});
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err2) {
      console.warn('Huh?: tab capture failed', err, err2);
      await toast(tabId, `Huh? couldn't listen to this tab: ${(err2 as Error).message}`);
      return false;
    }
  }

  const res = await toOffscreen<{ ok: boolean; error?: string }>({ type: 'START', streamId, tabId });
  if (!res?.ok) {
    await toast(tabId, `Huh? couldn't start listening: ${res?.error ?? 'unknown error'}`);
    return false;
  }
  if (previous && previous.tabId !== tabId) await setBadge(previous.tabId, false);
  await saveArmed({ tabId, origin });
  await setBadge(tabId, true);
  return true;
}

async function disarm() {
  const armed = await loadArmed();
  await saveArmed(null);
  if (armed) await setBadge(armed.tabId, false);
  if (await hasOffscreen()) {
    await toOffscreen({ type: 'STOP_AUDIO' }).catch(() => {});
    await toOffscreen({ type: 'STOP' }).catch(() => {});
  }
}

// ---------------------------------------------------------------- backend API

class ApiError extends Error {}

async function api<T>(settings: Settings, path: string, body: FormData | object): Promise<T> {
  const headers: Record<string, string> = { 'x-huh-install-id': await getInstallId() };
  let payload: BodyInit;
  if (body instanceof FormData) payload = body;
  else {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(settings.backendUrl + path, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') throw new ApiError('The Huh? server took too long to answer.');
    throw new ApiError(`Can't reach the Huh? server at ${settings.backendUrl}. Is it running?`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json?.error?.message ?? `Server error (${res.status}).`);
  return json as T;
}

interface TranscribeResult {
  transcript: string;
  detectedLang: string | null;
}

// ---------------------------------------------------------------- the pipeline

interface Run {
  runId: number;
  tabId: number;
  settings: Settings;
  page: PageInfo;
  wav: string;
  clipSeconds: number;
  previousTranscript?: string;
  startedAt: number;
  closed: boolean;
  transcript?: TranscribeResult;
  englishFast?: Promise<TranscribeResult> | null;
  translation?: string;
  explanation?: Explanation;
  speechAudio?: string;
  timings: Record<string, number>;
}

/** Latest run per tab; kept in memory only (audio never touches storage). */
const runs = new Map<number, Run>();
let speakingRun: Run | null = null;

function patch(run: Run, p: Partial<CardState>) {
  if (run.closed) return;
  if (run.settings.devMode) p = { ...p, timings: { ...run.timings } };
  void toContent(run.tabId, { type: 'HUH_PATCH_CARD', runId: run.runId, patch: p });
}

function mark(run: Run, stage: string) {
  run.timings[stage] = Date.now() - run.startedAt;
}

const TITLE_STOPWORDS = new Set(
  'the and for with from that this what when where how why who are you your our its official video full episode new live part ft feat vs into about'.split(
    ' ',
  ),
);

/** Proper-noun-ish words from the video title, used as STT keyterms. */
function titleKeyterms(title: string): string[] {
  const words = title.match(/\b[A-Z][A-Za-z0-9'’-]{2,}\b/g) ?? [];
  return [...new Set(words.filter((w) => !TITLE_STOPWORDS.has(w.toLowerCase())))].slice(0, 10);
}

function wavForm(run: Run, mode?: 'translate'): FormData {
  const form = new FormData();
  form.append('audio', new Blob([base64ToBytes(run.wav)], { type: 'audio/wav' }), 'clip.wav');
  if (mode) form.append('mode', mode);
  const keyterms = titleKeyterms(run.page.title);
  if (keyterms.length) form.append('keyterms', JSON.stringify(keyterms));
  return form;
}

async function trigger(tab: chrome.tabs.Tab) {
  const tabId = tab.id!;
  const settings = await getSettings();
  if (!(await ensureContent(tabId))) return;

  const previous = runs.get(tabId);
  if (previous) previous.closed = true;

  const runId = Date.now();
  const card: CardState = {
    runId,
    clipSeconds: settings.clipSeconds,
    status: { kind: 'working', text: `Listening back ${settings.clipSeconds}s…` },
    sourceLang: null,
    targetLang: settings.targetLang,
    canSpeak: canSpeak(settings.targetLang),
    transcript: { state: 'loading' },
    translation: { state: 'idle' },
    explanation: { state: 'idle' },
    speech: 'idle',
  };
  await toContent(tabId, { type: 'HUH_OPEN_CARD', card });

  const [page, clip, prev] = await Promise.all([
    toContent<PageInfo>(tabId, { type: 'HUH_PAGE_INFO' }),
    toOffscreen<ClipResult>({ type: 'GET_CLIP', seconds: settings.clipSeconds }).catch(
      (err): ClipResult => ({ ok: false, error: String(err?.message ?? err) }),
    ),
    chrome.storage.session.get(`prev:${tabId}`),
  ]);

  const run: Run = {
    runId,
    tabId,
    settings,
    page: page ?? { title: tab.title ?? '', url: tab.url ?? '' },
    wav: clip.ok ? clip.wav : '',
    clipSeconds: clip.ok ? clip.seconds : settings.clipSeconds,
    previousTranscript: prev[`prev:${tabId}`] as string | undefined,
    startedAt: runId,
    closed: false,
    timings: {},
  };
  runs.set(tabId, run);
  mark(run, 'clip');

  if (!clip.ok) {
    patch(run, { status: { kind: 'error', text: clip.error }, transcript: { state: 'idle' } });
    return;
  }
  if (clip.rms < SILENCE_RMS) {
    patch(run, {
      status: { kind: 'error', text: `Didn't catch any speech in the last ${Math.round(clip.seconds)} seconds.` },
      transcript: { state: 'idle' },
    });
    return;
  }
  await runTranscribe(run);
}

async function runTranscribe(run: Run) {
  patch(run, {
    status: { kind: 'working', text: 'Transcribing…' },
    transcript: { state: 'loading' },
    translation: { state: 'idle' },
    explanation: { state: 'idle' },
  });

  // English fast path: saaras mode=translate returns speech→English in one hop, alongside
  // the original-language transcript. Used instead of /translate when the speech isn't English.
  run.englishFast =
    run.settings.targetLang === 'en-IN' ? api<TranscribeResult>(run.settings, '/api/transcribe', wavForm(run, 'translate')) : null;
  run.englishFast?.catch(() => {});

  try {
    run.transcript = await api<TranscribeResult>(run.settings, '/api/transcribe', wavForm(run));
  } catch (err) {
    patch(run, { status: { kind: 'error' }, transcript: { state: 'error', error: (err as Error).message } });
    return;
  }
  mark(run, 'transcript');

  const { transcript, detectedLang } = run.transcript;
  if (!transcript) {
    patch(run, {
      status: { kind: 'error', text: `Didn't catch any words in the last ${Math.round(run.clipSeconds)} seconds.` },
      transcript: { state: 'idle' },
    });
    return;
  }
  patch(run, {
    status: { kind: 'working', text: 'Explaining…' },
    sourceLang: detectedLang,
    transcript: { state: 'done', value: transcript },
  });
  // Remember this clip as context for the next one on this tab.
  void chrome.storage.session.set({ [`prev:${run.tabId}`]: transcript });

  await Promise.allSettled([runTranslate(run), runExplain(run)]);
  patch(run, { status: { kind: 'done' } });
}

async function runTranslate(run: Run) {
  const t = run.transcript!;
  patch(run, { translation: { state: 'loading' } });
  try {
    let text: string | undefined;
    if (run.englishFast && t.detectedLang !== 'en-IN') {
      text = (await run.englishFast.catch(() => null))?.transcript || undefined;
    }
    text ??= (
      await api<{ translatedText: string }>(run.settings, '/api/translate', {
        text: t.transcript,
        sourceLang: t.detectedLang,
        targetLang: run.settings.targetLang,
        style: run.settings.style,
      })
    ).translatedText;
    run.translation = text;
    mark(run, 'translation');
    patch(run, { translation: { state: 'done', value: text } });
  } catch (err) {
    patch(run, { translation: { state: 'error', error: (err as Error).message } });
  }
}

async function runExplain(run: Run) {
  const t = run.transcript!;
  patch(run, { explanation: { state: 'loading' } });
  try {
    const result = await api<Explanation>(run.settings, '/api/explain', {
      transcript: t.transcript,
      translation: run.translation, // set only if translation already finished (e.g. on retry)
      sourceLang: t.detectedLang,
      targetLang: run.settings.targetLang,
      videoTitle: run.page.title.slice(0, 500),
      pageUrl: run.page.url.slice(0, 2000),
      previousTranscript: run.previousTranscript?.slice(0, 5000),
    });
    run.explanation = result;
    run.speechAudio = undefined;
    mark(run, 'explanation');
    patch(run, { explanation: { state: 'done', value: result } });
    if (run.settings.autoPlay && canSpeak(run.settings.targetLang)) void speak(run);
  } catch (err) {
    patch(run, { explanation: { state: 'error', error: (err as Error).message } });
  }
}

async function speak(run: Run) {
  if (!run.explanation?.explanation) return;
  if (speakingRun && speakingRun !== run) await stopSpeech();
  speakingRun = run;
  patch(run, { speech: 'loading', speechError: undefined });
  try {
    run.speechAudio ??= (
      await api<{ audio: string }>(run.settings, '/api/speak', {
        text: run.explanation.explanation.slice(0, 2500),
        targetLang: run.settings.targetLang,
        speaker: run.settings.speaker || undefined,
      })
    ).audio;
    if (speakingRun !== run || run.closed) return;
    const res = await toOffscreen<{ ok: boolean; error?: string }>({
      type: 'PLAY_AUDIO',
      audio: run.speechAudio,
      mimeType: 'audio/mpeg',
    });
    if (!res?.ok) throw new Error(res?.error ?? 'Could not play audio.');
    patch(run, { speech: 'playing' });
  } catch (err) {
    speakingRun = null;
    patch(run, { speech: 'error', speechError: (err as Error).message });
  }
}

async function stopSpeech() {
  const run = speakingRun;
  speakingRun = null;
  if (await hasOffscreen()) await toOffscreen({ type: 'STOP_AUDIO' }).catch(() => {});
  if (run) patch(run, { speech: 'idle' });
}

function runFor(tabId: number | undefined, runId: number): Run | undefined {
  const run = tabId == null ? undefined : runs.get(tabId);
  return run && run.runId === runId ? run : undefined;
}

async function retry(run: Run, section: SectionName) {
  run.closed = false;
  if (section === 'transcript') return runTranscribe(run);
  if (section === 'translation') {
    run.englishFast = null; // the fast path may be what failed; go through /translate
    return runTranslate(run);
  }
  return runExplain(run);
}

// ---------------------------------------------------------------- entry points

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Toolbar click toggles listening on that tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  const armed = await currentArmed();
  if (armed?.tabId === tab.id) {
    await disarm();
    await toast(tab.id, 'Huh? stopped listening to this tab.');
    return;
  }
  if (await arm(tab)) {
    await toast(tab.id, `Huh? is listening — press ${await shortcutLabel()} after you miss something.`);
  }
});

async function onShortcut(tab?: chrome.tabs.Tab) {
  tab = tab?.id != null ? tab : await activeTab();
  if (tab?.id == null) return;

  const armed = await currentArmed();
  if (armed?.tabId !== tab.id) {
    if (await arm(tab)) await toast(tab.id, 'Huh? is listening — press again after you miss something.');
    return;
  }
  await trigger(tab);
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'trigger-huh') void onShortcut(tab);
});

// Debug handle for the service-worker console (and the e2e script): `await huh.shortcut()`.
Object.assign(globalThis, { huh: { shortcut: () => onShortcut(), status: offscreenStatus, armed: currentArmed } });

chrome.runtime.onMessage.addListener((msg: BackgroundMessage | OffscreenEvent, sender, sendResponse) => {
  if ((msg as OffscreenEvent).target === 'background') {
    const ev = msg as OffscreenEvent;
    if (ev.type === 'CAPTURE_ENDED') void disarm();
    if (ev.type === 'AUDIO_ENDED' && speakingRun) {
      patch(speakingRun, { speech: 'idle' });
      speakingRun = null;
    }
    return false;
  }
  if ((msg as { target?: string }).target === 'offscreen') return false;

  const m = msg as BackgroundMessage;
  const tabId = sender.tab?.id;
  switch (m.type) {
    case 'HUH_SPEAK': {
      const run = runFor(tabId, m.runId);
      if (run) void speak(run);
      break;
    }
    case 'HUH_STOP_SPEECH':
      void stopSpeech();
      break;
    case 'HUH_RETRY': {
      const run = runFor(tabId, m.runId);
      if (run) void retry(run, m.section);
      break;
    }
    case 'HUH_CARD_CLOSED': {
      const run = runFor(tabId, m.runId);
      if (run) {
        if (speakingRun === run) void stopSpeech();
        run.closed = true;
      }
      break;
    }
    case 'HUH_OPEN_OPTIONS':
      void chrome.runtime.openOptionsPage();
      break;
  }
  sendResponse({ ok: true });
  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  runs.delete(tabId);
  void chrome.storage.session.remove(`prev:${tabId}`);
  const armed = await loadArmed();
  if (armed?.tabId === tabId) await disarm();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const armed = await loadArmed();
  if (armed?.tabId !== tabId) return;
  if (info.url && originOf(info.url) !== armed.origin) {
    runs.delete(tabId);
    await disarm();
    return;
  }
  // Tab-specific badge text resets on navigation; put it back.
  if (info.status === 'complete' && originOf(tab.url) === armed.origin) await setBadge(tabId, true);
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});
