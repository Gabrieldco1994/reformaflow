import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Trava de banco: nenhum teste pode enxergar o dev.db real (ver scripts/test-db-env.cjs).
    // O domínio hoje não usa Prisma, mas o setup vale para qualquer teste futuro que use.
    setupFiles: ['../../scripts/test-db-env.cjs'],
  },
});
