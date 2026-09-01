import { readFileSync } from 'fs';
import { join } from 'path';

describe('classifyBatch — guardas estruturais de persistência (#582 SEC-3)', () => {
  const src = readFileSync(join(__dirname, 'merchant-classifier.service.ts'), 'utf8');
  const start = src.indexOf('async classifyBatch(');
  const endMarker = src.indexOf('async setManual(', start);
  const body = src.slice(start, endMarker > -1 ? endMarker : undefined);

  it('classifyBatch existe e é isolável', () => {
    expect(start).toBeGreaterThan(-1);
    expect(endMarker).toBeGreaterThan(start);
  });

  it('não usa skipDuplicates (inexistente no client SQLite e mascararia MANUAL)', () => {
    expect(src).not.toMatch(/skipDuplicates/);
  });

  it('não chama merchantCategory.upsert dentro de classifyBatch', () => {
    expect(body).not.toMatch(/merchantCategory\.upsert\s*\(/);
  });

  it('persiste via createMany + updateMany/update guardado por source', () => {
    expect(body).toMatch(/merchantCategory\.createMany\s*\(/);
    expect(body).toMatch(/source:\s*['"]AI['"]/);
  });

  it('valida tenantId antes da primeira query (SEC-2)', () => {
    const guardIdx = body.search(/if\s*\(\s*!tenantId/);
    const firstQueryIdx = body.search(/this\.prisma\.merchantCategory\./);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(firstQueryIdx === -1 ? Number.MAX_SAFE_INTEGER : firstQueryIdx);
  });

  it('a re-leitura de source acontece dentro de $transaction interativa', () => {
    expect(body).toMatch(/\$transaction\(\s*async\s*\(/);
  });
});
