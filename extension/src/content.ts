// Injected on demand. Renders the Huh? card in a Shadow DOM root and pauses/resumes the video.
import css from './card.css?inline';
import { LANGUAGES, shortCode } from './lib/languages';
import type { BackgroundMessage, CardState, ContentMessage, PageInfo, SectionName } from './lib/messages';

declare global {
  interface Window {
    __huhInstance?: symbol;
  }
}

// A re-injection (e.g. after the extension reloads) supersedes the old, orphaned instance.
const instance = Symbol('huh');
window.__huhInstance = instance;
const alive = () => window.__huhInstance === instance;

const HOST_ID = 'huh-extension-root';
document.getElementById(HOST_ID)?.remove();

const host = document.createElement('div');
host.id = HOST_ID;
const root = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = css;
root.append(style);

// Keep page shortcuts (YouTube's space/k/j/l…) from firing while the user is in the card.
for (const type of ['keydown', 'keyup', 'keypress'] as const) {
  host.addEventListener(type, (e) => {
    if ((e as KeyboardEvent).key !== 'Escape') e.stopPropagation();
  });
}

function mountHost() {
  // In fullscreen only the fullscreen element's subtree is visible, so move the card inside it.
  const fs = document.fullscreenElement;
  const parent = fs && !(fs instanceof HTMLVideoElement) ? fs : document.documentElement;
  if (host.parentNode !== parent) parent.append(host);
}
document.addEventListener('fullscreenchange', () => {
  if (alive() && (card || toastEl)) mountHost();
});

const send = (msg: BackgroundMessage) => {
  if (alive()) chrome.runtime.sendMessage(msg).catch(() => {});
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------------------------------------------------------------- video control

let video: HTMLVideoElement | null = null;
let wasPlaying = false;

function pickVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const area = w * h;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

function pageInfo(): PageInfo {
  const ytTitle = document.querySelector('ytd-watch-metadata h1')?.textContent?.trim();
  const title = ytTitle || document.title.replace(/\s+-\s+YouTube$/, '').trim();
  return { title, url: location.href };
}

// ---------------------------------------------------------------- toast

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;

function showToast(text: string) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = document.createElement('div');
  toastEl.className = 'toast';
  toastEl.setAttribute('role', 'status');
  toastEl.textContent = text;
  if (card) toastEl.style.bottom = `${(cardEl?.offsetHeight ?? 0) + 28}px`;
  root.append(toastEl);
  mountHost();
  toastTimer = window.setTimeout(() => {
    toastEl?.remove();
    toastEl = null;
  }, 4000);
}

// ---------------------------------------------------------------- card

let card: CardState | null = null;
let cardEl: HTMLDivElement | null = null;

const SKELETON = '<div class="skeleton"></div><div class="skeleton short"></div>';

function langLabel(code: string | null): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code ?? 'unknown';
}

function retryHtml(section: SectionName, error: string) {
  return `<span class="err">${esc(error)}</span><button class="link" data-retry="${section}" aria-label="Retry ${section}">Retry</button>`;
}

function openCard(state: CardState) {
  closeCard(false);
  card = state;

  video = pickVideo();
  wasPlaying = Boolean(video && !video.paused && !video.ended);
  video?.pause();

  cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.tabIndex = -1;
  cardEl.setAttribute('role', 'dialog');
  cardEl.setAttribute('aria-label', 'Huh? — what was just said');
  cardEl.innerHTML = `
    <header>
      <div class="brand">Huh<span>?</span></div>
      <div class="chip" data-el="chip"></div>
      <div class="spacer"></div>
      <button class="icon-btn" data-act="options" aria-label="Huh? settings" title="Settings">⚙</button>
      <button class="icon-btn" data-act="close" aria-label="Close and resume video" title="Close (Esc)">✕</button>
    </header>
    <div class="status" data-el="status" aria-live="polite"></div>
    <section data-el="transcript" class="transcript" aria-label="Transcript"></section>
    <section data-el="translation" class="translation" aria-label="Translation"></section>
    <section data-el="explanation" class="explanation" aria-label="Explanation"></section>
    <div class="actions">
      <button class="btn primary" data-act="speak" aria-label="Listen to the explanation">🔊 Listen</button>
      <button class="btn" data-act="replay" aria-label="Replay the last ${state.clipSeconds} seconds">⏪ Replay</button>
      <button class="btn" data-act="copy" aria-label="Copy transcript and explanation">📋 Copy</button>
    </div>
    <div class="timings" data-el="timings" hidden></div>`;
  cardEl.addEventListener('click', onCardClick);
  root.append(cardEl);
  mountHost();
  render();
  cardEl.focus({ preventScroll: true });
}

function closeCard(resume = true) {
  if (!card) return;
  send({ type: 'HUH_CARD_CLOSED', runId: card.runId });
  cardEl?.remove();
  cardEl = null;
  card = null;
  if (resume && wasPlaying && video) void video.play().catch(() => {});
  video = null;
  wasPlaying = false;
}

const $ = (name: string) => cardEl?.querySelector<HTMLElement>(`[data-el="${name}"]`) ?? null;
const act = (name: string) => cardEl?.querySelector<HTMLButtonElement>(`[data-act="${name}"]`) ?? null;

function render() {
  if (!card || !cardEl) return;
  const c = card;

  $('chip')!.textContent = `${c.sourceLang ? shortCode(c.sourceLang) : '…'} → ${shortCode(c.targetLang)}`;
  $('chip')!.title = `${langLabel(c.sourceLang)} → ${langLabel(c.targetLang)}`;

  const status = $('status')!;
  status.className = c.status.kind === 'error' ? 'status error' : 'status';
  status.textContent = c.status.text ?? '';
  status.hidden = !c.status.text;

  const tr = $('transcript')!;
  tr.hidden = c.transcript.state === 'idle';
  if (c.transcript.state === 'loading') tr.innerHTML = SKELETON;
  else if (c.transcript.state === 'error') tr.innerHTML = retryHtml('transcript', c.transcript.error);
  else if (c.transcript.state === 'done') {
    tr.innerHTML = `<div class="label">Heard · ${esc(langLabel(c.sourceLang))}</div>${esc(c.transcript.value)}`;
    tr.lang = c.sourceLang?.split('-')[0] ?? '';
  }

  const tl = $('translation')!;
  // Hide the translation row when it would just repeat the transcript.
  const sameLang = c.sourceLang === c.targetLang;
  tl.hidden = c.translation.state === 'idle' || (sameLang && c.translation.state === 'done');
  if (c.translation.state === 'loading') tl.innerHTML = SKELETON;
  else if (c.translation.state === 'error') tl.innerHTML = retryHtml('translation', c.translation.error);
  else if (c.translation.state === 'done') {
    tl.textContent = c.translation.value;
    tl.lang = c.targetLang.split('-')[0];
  }

  const ex = $('explanation')!;
  ex.hidden = c.explanation.state === 'idle';
  if (c.explanation.state === 'loading') ex.innerHTML = `<div class="label">What they meant</div>${SKELETON}`;
  else if (c.explanation.state === 'error') ex.innerHTML = retryHtml('explanation', c.explanation.error);
  else if (c.explanation.state === 'done') {
    const { explanation, terms } = c.explanation.value;
    const termsHtml = terms.length
      ? `<ul class="terms">${terms
          .map((t) => `<li><b>${esc(t.term)}</b><span class="dash">—</span>${esc(t.meaning)}</li>`)
          .join('')}</ul>`
      : '';
    ex.innerHTML = `<div class="label">What they meant</div><div>${esc(explanation)}</div>${termsHtml}`;
    ex.lang = c.targetLang.split('-')[0];
  }

  const speakBtn = act('speak')!;
  speakBtn.hidden = !c.canSpeak;
  speakBtn.disabled = c.explanation.state !== 'done' || c.speech === 'loading';
  speakBtn.textContent =
    c.speech === 'loading' ? '… Loading' : c.speech === 'playing' ? '■ Stop' : c.speech === 'error' ? '🔊 Try again' : '🔊 Listen';
  speakBtn.title = c.speech === 'error' ? c.speechError ?? '' : '';
  speakBtn.setAttribute('aria-label', c.speech === 'playing' ? 'Stop audio' : 'Listen to the explanation');

  act('replay')!.disabled = !video;
  act('copy')!.disabled = c.transcript.state !== 'done';

  const timings = $('timings')!;
  timings.hidden = !c.timings;
  if (c.timings) {
    timings.textContent = Object.entries(c.timings)
      .map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}s`)
      .join(' · ');
  }
}

function copyText(): string {
  if (!card) return '';
  const parts: string[] = [];
  if (card.transcript.state === 'done') parts.push(card.transcript.value);
  if (card.translation.state === 'done' && card.sourceLang !== card.targetLang) parts.push(card.translation.value);
  if (card.explanation.state === 'done') {
    parts.push(card.explanation.value.explanation);
    for (const t of card.explanation.value.terms) parts.push(`• ${t.term} — ${t.meaning}`);
  }
  return parts.join('\n\n');
}

async function copy(btn: HTMLButtonElement) {
  const text = copyText();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    root.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = '✓ Copied';
  setTimeout(() => {
    if (btn.isConnected) btn.textContent = '📋 Copy';
  }, 1500);
}

function onCardClick(e: MouseEvent) {
  if (!card) return;
  const target = e.target as HTMLElement;
  const retry = target.closest<HTMLElement>('[data-retry]')?.dataset.retry as SectionName | undefined;
  if (retry) {
    send({ type: 'HUH_RETRY', runId: card.runId, section: retry });
    return;
  }
  const btn = target.closest<HTMLButtonElement>('[data-act]');
  if (!btn || btn.disabled) return;
  switch (btn.dataset.act) {
    case 'close':
      closeCard();
      break;
    case 'options':
      send({ type: 'HUH_OPEN_OPTIONS' });
      break;
    case 'speak':
      if (card.speech === 'playing') send({ type: 'HUH_STOP_SPEECH' });
      else send({ type: 'HUH_SPEAK', runId: card.runId });
      break;
    case 'replay':
      if (video) {
        video.currentTime = Math.max(0, video.currentTime - card.clipSeconds);
        void video.play().catch(() => {});
        wasPlaying = true;
      }
      break;
    case 'copy':
      void copy(btn);
      break;
  }
}

document.addEventListener(
  'keydown',
  (e) => {
    if (!alive() || !card || e.key !== 'Escape') return;
    // In fullscreen the browser uses Esc to exit fullscreen; leave that alone.
    if (document.fullscreenElement) return;
    e.stopPropagation();
    e.preventDefault();
    closeCard();
  },
  true,
);

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg: ContentMessage, _sender, sendResponse) => {
  if (!alive()) return false;
  switch (msg.type) {
    case 'HUH_PING':
      sendResponse({ ok: true });
      break;
    case 'HUH_TOAST':
      showToast(msg.text);
      sendResponse({ ok: true });
      break;
    case 'HUH_OPEN_CARD':
      openCard(msg.card);
      sendResponse({ ok: true });
      break;
    case 'HUH_PATCH_CARD':
      if (card && card.runId === msg.runId) {
        card = { ...card, ...msg.patch };
        render();
      }
      sendResponse({ ok: true });
      break;
    case 'HUH_PAGE_INFO':
      sendResponse(pageInfo());
      break;
    default:
      return false;
  }
  return false;
});
