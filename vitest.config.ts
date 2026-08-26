/**
 * Vitest projects: node tests for the host half, a DOM environment for the browser half.
 *
 * Split rather than one global environment because the host half opens real SQLite databases and
 * reads `node:crypto`, which a DOM environment does not serve, while the browser components need a
 * document. The split is by directory so a file's environment is visible from its path.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          environment: 'node',
          include: ['tests/host/**/*.spec.ts', 'tests/domain/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'client',
          environment: 'happy-dom',
          include: ['tests/client/**/*.spec.tsx', 'tests/client/**/*.spec.ts'],
        },
        esbuild: { jsx: 'automatic' },
        resolve: {
          alias: {
            // The design system is a runtime baseline external the Web Client's loader supplies; it
            // has no built `lib/` in a source checkout, and its real sources would pull the whole
            // markdown stack into a test about this package. See the stub's own module doc.
            '@deepseek-ai/dsh-client-ui-primitives':
              fileURLToPath(new URL('./tests/client/primitives-stub.tsx', import.meta.url)),
          },
        },
      },
    ],
  },
})
