// Holds the tab MediaStream and a rolling 25s PCM ring buffer. Audio never leaves memory
// unless the background asks for a clip after the user triggers.
import { arrayBufferToBase64, base64ToBytes, rms } from './lib/audio';
import type { ClipResult, OffscreenEvent, OffscreenRequest, OffscreenStatus } from './lib/messages';
import { RingBuffer } from './lib/ring-buffer';
import { encodeWav } from './lib/wav';

const SAMPLE_RATE = 16000;
const BUFFER_SECONDS = 25; // Sarvam's sync STT limit is 30s; never hold more than this.

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let capturingTabId: number | null = null;
const ring = new RingBuffer(SAMPLE_RATE * BUFFER_SECONDS);

let player: HTMLAudioElement | null = null;
let playerUrl: string | null = null;

function notify(event: OffscreenEvent) {
  chrome.runtime.sendMessage(event).catch(() => {});
}

async function start(streamId: string, tabId: number) {
  await stop();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as any,
    video: false,
  });
  ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  src.connect(ctx.destination); // REQUIRED: capturing mutes the tab unless we play it back
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('recorder-worklet.js'));
  node = new AudioWorkletNode(ctx, 'recorder');
  node.port.onmessage = (e: MessageEvent<Float32Array>) => ring.push(e.data);
  src.connect(node);
  capturingTabId = tabId;

  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      const ended = capturingTabId;
      void stop();
      notify({ target: 'background', type: 'CAPTURE_ENDED', tabId: ended });
    });
  }
}

async function stop() {
  node?.port.close();
  node?.disconnect();
  node = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
  capturingTabId = null;
  ring.clear();
}

function status(): OffscreenStatus {
  return { capturing: Boolean(stream), tabId: capturingTabId, bufferedSeconds: ring.length / SAMPLE_RATE };
}

function getClip(seconds: number): ClipResult {
  if (!stream) return { ok: false, error: 'Not listening to this tab.' };
  const samples = ring.latest(Math.round(Math.min(seconds, BUFFER_SECONDS) * SAMPLE_RATE));
  if (samples.length < SAMPLE_RATE) {
    return { ok: false, error: 'Just started listening — let it play a few seconds, then press again.' };
  }
  const wav = encodeWav(samples, SAMPLE_RATE);
  return { ok: true, wav: arrayBufferToBase64(wav), seconds: samples.length / SAMPLE_RATE, rms: rms(samples) };
}

function stopAudio() {
  player?.pause();
  player = null;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = null;
}

async function playAudio(b64: string, mimeType: string) {
  stopAudio();
  playerUrl = URL.createObjectURL(new Blob([base64ToBytes(b64)], { type: mimeType }));
  const audio = new Audio(playerUrl);
  player = audio;
  audio.addEventListener('ended', () => {
    if (player === audio) stopAudio();
    notify({ target: 'background', type: 'AUDIO_ENDED' });
  });
  await audio.play();
}

chrome.runtime.onMessage.addListener((msg: OffscreenRequest, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const reply = (p: Promise<unknown> | unknown) =>
    Promise.resolve(p).then(
      (v) => sendResponse(v ?? { ok: true }),
      (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
  switch (msg.type) {
    case 'START':
      reply(start(msg.streamId, msg.tabId).then(() => ({ ok: true })));
      break;
    case 'STOP':
      reply(stop().then(() => ({ ok: true })));
      break;
    case 'STATUS':
      reply(status());
      break;
    case 'GET_CLIP':
      reply(getClip(msg.seconds));
      break;
    case 'PLAY_AUDIO':
      reply(playAudio(msg.audio, msg.mimeType).then(() => ({ ok: true })));
      break;
    case 'STOP_AUDIO':
      stopAudio();
      reply({ ok: true });
      break;
    default:
      return false;
  }
  return true; // async response
});
