/**
 * Testa a própria trava que impede a suíte de escrever no dev.db real.
 * Ver scripts/test-db-env.cjs.
 */
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../../../scripts/test-db-env.cjs');

describe('trava de DATABASE_URL em testes', () => {
  it('a suíte roda contra o banco descartável do worktree, nunca o dev.db', () => {
    expect(process.env.DATABASE_URL).toBe(guard.TEST_DB_URL);
    expect(path.basename(guard.TEST_DB_PATH)).not.toBe('dev.db');
    expect(guard.TEST_DB_PATH.startsWith(guard.REPO_ROOT)).toBe(true);
  });

  it('recusa qualquer URL que aponte para um dev.db', () => {
    expect(guard.forbiddenReason('file:/Users/alguem/reformaflow/prisma/dev.db')).toMatch(/dev\.db/);
    expect(guard.forbiddenReason('file:./dev.db')).toMatch(/dev\.db/);
    expect(guard.forbiddenReason('file:dev.db')).toMatch(/dev\.db/);
  });

  it('recusa URL apontando para fora do worktree atual', () => {
    expect(guard.forbiddenReason('file:/tmp/outro-checkout/prisma/test.db')).toMatch(/fora do worktree/);
  });

  it('aceita o banco de teste do worktree', () => {
    expect(guard.forbiddenReason(guard.TEST_DB_URL)).toBeNull();
    expect(guard.forbiddenReason('file:test.db')).toBeNull();
  });

  it('ignora URLs sem arquivo (sqlite em memória)', () => {
    expect(guard.forbiddenReason('file::memory:')).toBeNull();
  });

  it('explode de forma legível se TEST_DATABASE_URL apontar para o dev.db', () => {
    const anterior = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = 'file:/Users/alguem/reformaflow/prisma/dev.db';
    try {
      expect(() => guard.applyTestDatabaseUrl()).toThrow(/TESTE ABORTADO: DATABASE_URL inseguro/);
    } finally {
      if (anterior === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = anterior;
      guard.applyTestDatabaseUrl();
    }
    expect(process.env.DATABASE_URL).toBe(guard.TEST_DB_URL);
  });
});
