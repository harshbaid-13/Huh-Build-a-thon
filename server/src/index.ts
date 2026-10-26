import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');

if (!process.env.SARVAM_API_KEY) {
  console.warn('warning: SARVAM_API_KEY is not set — copy .env.example to .env and add your key.');
}
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? '';
if (!allowedOrigin) {
  console.warn('warning: ALLOWED_ORIGIN is not set — accepting any chrome-extension:// origin (dev only).');
}

const port = Number(process.env.PORT ?? 8787);
const app = createApp({
  allowedOrigin,
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 30),
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Huh? server listening on http://localhost:${info.port}`);
});
