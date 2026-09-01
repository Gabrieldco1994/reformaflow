import { describe, expect, it, vi } from 'vitest';

/**
 * U6b build 1 (#456) — a flag é lida na importação do módulo (inlined pelo
 * Next.js em build-time), então cada caso reseta o registro de módulos do
 * Vitest para reavaliar `process.env` como se fosse um novo build.
 */
describe('CONTA_LENTE_POR_TIPO_ENABLED', () => {
  it('desabilitada quando a env var está ausente', async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_FEATURE_CONTA_LENTE_POR_TIPO;
    const { CONTA_LENTE_POR_TIPO_ENABLED } = await import('./feature-flags');
    expect(CONTA_LENTE_POR_TIPO_ENABLED).toBe(false);
  });

  it('desabilitada para qualquer valor diferente de "1" (nunca truthy solto)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_FEATURE_CONTA_LENTE_POR_TIPO = 'true';
    const { CONTA_LENTE_POR_TIPO_ENABLED } = await import('./feature-flags');
    expect(CONTA_LENTE_POR_TIPO_ENABLED).toBe(false);
    delete process.env.NEXT_PUBLIC_FEATURE_CONTA_LENTE_POR_TIPO;
  });

  it('habilitada somente quando === "1"', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_FEATURE_CONTA_LENTE_POR_TIPO = '1';
    const { CONTA_LENTE_POR_TIPO_ENABLED } = await import('./feature-flags');
    expect(CONTA_LENTE_POR_TIPO_ENABLED).toBe(true);
    delete process.env.NEXT_PUBLIC_FEATURE_CONTA_LENTE_POR_TIPO;
  });
});
