// Builds the extension into dist/ (load-unpacked ready). `--watch` rebuilds on change.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'vite';
import { ENTRIES, entryConfig } from '../vite.config.ts';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const copyStatic = () => {
  cpSync('manifest.json', 'dist/manifest.json');
  cpSync('public', 'dist', { recursive: true });
  for (const f of ['offscreen.html', 'options.html', 'onboarding.html', 'pages.css']) cpSync(`src/${f}`, `dist/${f}`);
};
copyStatic();

for (const name of Object.keys(ENTRIES)) {
  await build(entryConfig(name, { watch }));
}
console.log(watch ? 'Watching for changes…' : 'Built extension → dist/');
