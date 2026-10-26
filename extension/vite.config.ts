import { defineConfig, type UserConfig } from 'vite';

/**
 * Chrome needs each entry as one self-contained file: content scripts and audio worklets can't
 * import shared chunks. So every entry is built separately in library mode (see scripts/build.mjs,
 * which calls entryConfig() once per entry). This default export is used by Vitest.
 */
export const ENTRIES = {
  background: { file: 'src/background.ts', format: 'es' },
  content: { file: 'src/content.ts', format: 'iife' },
  offscreen: { file: 'src/offscreen.ts', format: 'iife' },
  'recorder-worklet': { file: 'src/recorder-worklet.ts', format: 'iife' },
  options: { file: 'src/options.ts', format: 'iife' },
  onboarding: { file: 'src/onboarding.ts', format: 'iife' },
} as const;

export function entryConfig(name: keyof typeof ENTRIES, opts: { watch?: boolean } = {}): UserConfig {
  const { file, format } = ENTRIES[name];
  return {
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'chrome116',
      minify: false,
      sourcemap: false,
      watch: opts.watch ? {} : null,
      lib: {
        entry: file,
        formats: [format],
        name: `huh_${name.replace(/-/g, '_')}`,
        fileName: () => `${name}.js`,
      },
    },
  } as UserConfig;
}

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
} as UserConfig);
