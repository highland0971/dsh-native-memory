import { defineConfig } from 'tsdown'

// Mirrors deepseek-harness's own packaging shape: ES module output into lib/,
// declaration types beside it, cordis.patch.yml shipped as a file.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'lib',
  target: 'node22',
})
