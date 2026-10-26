import { LANGUAGES, VOICES } from './lib/languages';
import { getSettings, saveSettings, type Settings } from './lib/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const targetLang = $<HTMLSelectElement>('targetLang');
const style = $<HTMLSelectElement>('style');
const clipSeconds = $<HTMLInputElement>('clipSeconds');
const clipOut = $<HTMLOutputElement>('clipOut');
const speaker = $<HTMLSelectElement>('speaker');
const autoPlay = $<HTMLInputElement>('autoPlay');
const backendUrl = $<HTMLInputElement>('backendUrl');
const devMode = $<HTMLInputElement>('devMode');
const saved = $('saved');
const health = $('health');

for (const l of LANGUAGES) targetLang.add(new Option(l.native === l.name ? l.name : `${l.name} — ${l.native}`, l.code));
for (const v of VOICES) speaker.add(new Option(v.label, v.id));

let savedTimer: number | undefined;
async function save(patch: Partial<Settings>) {
  await saveSettings(patch);
  saved.textContent = 'Saved.';
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (saved.textContent = ''), 1500);
}

async function checkHealth(url: string) {
  health.className = 'status-line';
  health.textContent = 'Checking…';
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(4000) });
    const json = await res.json();
    if (!json.ok) throw new Error();
    health.className = json.hasKey ? 'status-line ok' : 'status-line err';
    health.textContent = json.hasKey ? '● Server is up' : '● Server is up, but SARVAM_API_KEY is missing';
  } catch {
    health.className = 'status-line err';
    health.textContent = '● Can’t reach the server — run `npm run dev` in server/';
  }
}

async function init() {
  const s = await getSettings();
  targetLang.value = s.targetLang;
  style.value = s.style;
  clipSeconds.value = String(s.clipSeconds);
  clipOut.value = `${s.clipSeconds}s`;
  speaker.value = s.speaker;
  autoPlay.checked = s.autoPlay;
  backendUrl.value = s.backendUrl;
  devMode.checked = s.devMode;
  void checkHealth(s.backendUrl);

  const cmds = await chrome.commands.getAll();
  const sc = cmds.find((c) => c.name === 'trigger-huh')?.shortcut;
  $('shortcut').textContent = sc || 'not set';
}

targetLang.addEventListener('change', () => save({ targetLang: targetLang.value }));
style.addEventListener('change', () => save({ style: style.value as Settings['style'] }));
clipSeconds.addEventListener('input', () => (clipOut.value = `${clipSeconds.value}s`));
clipSeconds.addEventListener('change', () => save({ clipSeconds: Number(clipSeconds.value) }));
speaker.addEventListener('change', () => save({ speaker: speaker.value }));
autoPlay.addEventListener('change', () => save({ autoPlay: autoPlay.checked }));
devMode.addEventListener('change', () => save({ devMode: devMode.checked }));
backendUrl.addEventListener('change', () => {
  const url = backendUrl.value.trim().replace(/\/+$/, '') || 'http://localhost:8787';
  backendUrl.value = url;
  void save({ backendUrl: url });
  void checkHealth(url);
});
$('shortcuts-link').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
$('form').addEventListener('submit', (e) => e.preventDefault());

void init();
