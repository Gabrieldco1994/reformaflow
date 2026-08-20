import { describe, expect, it } from 'vitest';
import { getProjectNavModules, ProjectType } from '@reformaflow/domain';
import {
  NAV_SHARED_PARAMS,
  buildNavHref,
  preserveNavParams,
  readMonthParam,
} from './nav-href';
import { isPathActive } from '../_components/mobile-nav';

/**
 * U2 §5 (adendo) — contrato de transporte de contexto do shell.
 *
 * O allowlist `NAV_SHARED_PARAMS` é DADO literal, não derivado da query de
 * nenhuma rota. Passthrough total seria ativamente errado (ver U2-P02: `launch`
 * é lido globalmente pelo AppShell e reabriria a sheet a cada toque no dock).
 */
describe('nav-href — transporte de contexto compartilhado', () => {
  it('[TRAVA] o allowlist tem exatamente um item: mes', () => {
    expect([...NAV_SHARED_PARAMS]).toEqual(['mes']);
  });

  it('[RED] U2-P01: carrega apenas params do allowlist', () => {
    expect(buildNavHref('/projects/p1/conta', 'mes=2026-03&q=luz&view=month')).toBe(
      '/projects/p1/conta?mes=2026-03',
    );
  });

  it('[RED] U2-P02: NUNCA carrega launch — reabrir a sheet a cada toque é bug novo', () => {
    // A prova ATIVA do allowlist: `launch` é global (AppShell), passthrough
    // reabriria a sheet de lançamento a cada navegação.
    expect(buildNavHref('/projects/p1/monthly', 'launch=1&mes=2026-03')).toBe(
      '/projects/p1/monthly?mes=2026-03',
    );
    expect(preserveNavParams('launch=1')).toBe('');
  });

  // U2-P18/colisão latente: `focus` existe em credit-cards (closingDay) e
  // bank-accounts (openingBalance) com valores hoje disjuntos — nada dispara,
  // mas é chave compartilhada num namespace global; descartar é a defesa.
  const FORBIDDEN = ['focus', 'last4', 'new', 'quick', 'priceItemId', 'projectId'];
  it.each(FORBIDDEN)('[RED] U2-P03: NUNCA carrega %s', (key) => {
    expect(buildNavHref('/projects/p1/x', `${key}=algo`)).toBe('/projects/p1/x');
    // e não contamina quando vem junto com um param legítimo
    expect(buildNavHref('/projects/p1/x', `${key}=algo&mes=2026-03`)).toBe(
      '/projects/p1/x?mes=2026-03',
    );
  });

  const BAD_MONTHS = ['', 'banana', '2026-13', '2026-00', '26-03', '2026-3', '2026-1'];
  it.each(BAD_MONTHS)('[RED] U2-P04: mes malformado (%s) é descartado', (value) => {
    expect(buildNavHref('/projects/p1/conta', `mes=${value}`)).toBe('/projects/p1/conta');
    expect(readMonthParam(`mes=${value}`)).toBeNull();
  });

  const GOOD_MONTHS = ['2026-01', '2026-12', '2026-03'];
  it.each(GOOD_MONTHS)('[RED] U2-P04: mes válido (%s) é preservado', (value) => {
    expect(buildNavHref('/projects/p1/conta', `mes=${value}`)).toBe(
      `/projects/p1/conta?mes=${value}`,
    );
    expect(readMonthParam(`mes=${value}`)).toBe(value);
  });

  it('[RED] U2-P05: pathHref sai sem query e é o que alimenta isPathActive', () => {
    const pathname = '/projects/p1/conta';
    const pathHref = '/projects/p1/conta';
    const linkHref = buildNavHref(pathHref, 'mes=2026-03');
    expect(linkHref).toBe('/projects/p1/conta?mes=2026-03');
    // pathname NUNCA contém query — só o pathHref casa.
    expect(isPathActive(pathname, pathHref)).toBe(true);
    expect(isPathActive(pathname, linkHref)).toBe(false);
  });

  it('[RED] U2-P06: sem nada a preservar não emite "?"', () => {
    expect(buildNavHref('/x', '')).toBe('/x');
    expect(buildNavHref('/x', null)).toBe('/x');
    expect(buildNavHref('/x', 'launch=1')).toBe('/x');
    expect(preserveNavParams('')).toBe('');
    expect(preserveNavParams(null)).toBe('');
  });

  it('[RED] U2-P07: chave repetida vence a primeira, sem duplicar', () => {
    expect(buildNavHref('/x', 'mes=2026-03&mes=2026-05')).toBe('/x?mes=2026-03');
  });

  it('[RED] U2-P08: ordem determinística pela allowlist, não pela chegada', () => {
    // Independente da ordem de chegada, a saída é determinística (deriva do
    // allowlist, não da query). Com a lista atual (só `mes`) isso significa que
    // params privados nunca reordenam nem aparecem.
    expect(buildNavHref('/x', 'q=1&mes=2026-03&view=month')).toBe('/x?mes=2026-03');
    expect(buildNavHref('/x', 'mes=2026-03&q=1&view=month')).toBe('/x?mes=2026-03');
  });

  it('[RED] U2-P09: destino que sai do projeto não recebe param', () => {
    expect(buildNavHref('/settings', 'mes=2026-03', { leavesProject: true })).toBe('/settings');
    expect(buildNavHref('/admin/users', 'mes=2026-03', { leavesProject: true })).toBe(
      '/admin/users',
    );
    expect(buildNavHref('/projects', 'mes=2026-03', { leavesProject: true })).toBe('/projects');
  });

  it('[TRAVA] U2-P10: scope nunca cai — todo destino de PROJECT_NAV começa por basePath', () => {
    const basePath = '/projects/p1';
    for (const type of Object.values(ProjectType)) {
      for (const module of getProjectNavModules(type)) {
        const pathHref = `${basePath}/${module.slug}`;
        expect(pathHref.startsWith(`${basePath}/`)).toBe(true);
        expect(buildNavHref(pathHref, 'mes=2026-03').startsWith(`${basePath}/`)).toBe(true);
      }
    }
  });
});
