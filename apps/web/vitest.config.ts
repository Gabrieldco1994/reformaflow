import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@reformaflow/domain': fileURLToPath(
        new URL('../../packages/domain/src', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // A trava de banco vem primeiro: nenhum teste pode enxergar o dev.db real
    // (ver scripts/test-db-env.cjs). O web não usa Prisma hoje, mas o setup é
    // uniforme entre os três runners do monorepo.
    setupFiles: ['../../scripts/test-db-env.cjs', './vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'e2e', 'tests-e2e', '**/*.spec.e2e.*'],
  },
});
