import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
  deps: { neverBundle: ['electron'] },
} as const

/** Build the main process, utility Host, and isolated preload as independent artifacts. */
export default defineConfig([
  { ...shared, entry: ['lib/types/main.js'], format: ['esm'] },
  { ...shared, entry: ['lib/types/host.js'], format: ['esm'] },
  { ...shared, entry: ['lib/types/preload.js'], format: ['cjs'] },
])
