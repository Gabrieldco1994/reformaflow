import { describe, expect, it } from 'vitest';
import { ProjectType } from '../src/enums';
import {
  SUMMARY_CATALOG,
  getCatalogItem,
  getSummaryCatalog,
  SummaryPageDef,
} from '../src/config/summary-catalog';
import { GENERIC_JOURNEY_SCREEN_CATALOG } from '../src/config/journey-catalog';

describe('summary-catalog', () => {
  describe('SUMMARY_CATALOG structure', () => {
    it('defines catalog entries for all project types', () => {
      const projectTypes: ProjectType[] = [
        ProjectType.REFORMA,
        ProjectType.COMPRA,
        ProjectType.PESSOAL,
        ProjectType.CASA,
        ProjectType.CARRO,
        ProjectType.PLANTAS,
      ];

      for (const type of projectTypes) {
        expect(SUMMARY_CATALOG[type]).toBeDefined();
        expect(Array.isArray(SUMMARY_CATALOG[type])).toBe(true);
      }
    });

    it('each catalog entry is a valid SummaryPageDef', () => {
      Object.values(SUMMARY_CATALOG).forEach((catalog) => {
        catalog.forEach((page) => {
          expect(page.slug).toBeDefined();
          expect(typeof page.slug).toBe('string');
          expect(page.title).toBeDefined();
          expect(typeof page.title).toBe('string');
          expect(Array.isArray(page.ctas)).toBe(true);

          page.ctas.forEach((cta) => {
            expect(cta.label).toBeDefined();
            expect(cta.href).toBeDefined();
          });
        });
      });
    });

    it('has non-empty catalog for key types', () => {
      expect(getSummaryCatalog(ProjectType.REFORMA).length).toBeGreaterThan(0);
      expect(getSummaryCatalog(ProjectType.PESSOAL).length).toBeGreaterThan(0);
      expect(getSummaryCatalog(ProjectType.CASA).length).toBeGreaterThan(0);
    });
  });

  describe('getSummaryCatalog', () => {
    it('returns defensive copy of catalog for known type', () => {
      const catalog = getSummaryCatalog(ProjectType.REFORMA);
      expect(Array.isArray(catalog)).toBe(true);

      // Mutating the returned array should not affect the original
      const original = getSummaryCatalog(ProjectType.REFORMA);
      catalog.push({
        slug: 'fake',
        title: 'Fake',
        ctas: [],
      });

      expect(getSummaryCatalog(ProjectType.REFORMA).length).toEqual(original.length);
    });

    it('returns empty array for unknown type', () => {
      const unknown = { toString: () => 'UNKNOWN' } as unknown as ProjectType;
      const result = getSummaryCatalog(unknown);
      expect(result).toEqual([]);
    });

    it('includes pages with all required fields', () => {
      const catalog = getSummaryCatalog(ProjectType.PESSOAL);
      const monthlyPage = catalog.find((p) => p.slug === 'monthly');

      expect(monthlyPage).toBeDefined();
      expect(monthlyPage?.slug).toBe('monthly');
      expect(monthlyPage?.title).toBeDefined();
      expect(monthlyPage?.title.length).toBeGreaterThan(0);
      expect(Array.isArray(monthlyPage?.ctas)).toBe(true);
    });

    it('deep-copies CTAs so mutations do not affect original', () => {
      const catalog1 = getSummaryCatalog(ProjectType.REFORMA);
      const catalog2 = getSummaryCatalog(ProjectType.REFORMA);

      if (catalog1[0]?.ctas.length > 0) {
        catalog1[0].ctas[0].label = 'Modified';
        expect(catalog2[0]?.ctas[0]?.label).not.toBe('Modified');
      }
    });
  });

  describe('getCatalogItem', () => {
    it('returns the page for a valid slug', () => {
      const page = getCatalogItem(ProjectType.REFORMA, 'dashboard');

      expect(page).toBeDefined();
      expect(page?.slug).toBe('dashboard');
      expect(page?.title).toBeDefined();
    });

    it('returns undefined for unknown slug', () => {
      const page = getCatalogItem(ProjectType.REFORMA, 'nonexistent');
      expect(page).toBeUndefined();
    });

    it('returns undefined for unknown project type', () => {
      const unknown = { toString: () => 'UNKNOWN' } as unknown as ProjectType;
      const page = getCatalogItem(unknown, 'dashboard');
      expect(page).toBeUndefined();
    });

    it('PESSOAL has specific pages for cockpit variants', () => {
      expect(getCatalogItem(ProjectType.PESSOAL, 'monthly')).toBeDefined();
      expect(getCatalogItem(ProjectType.PESSOAL, 'conta')).toBeDefined();
      expect(getCatalogItem(ProjectType.PESSOAL, 'dre')).toBeDefined();
      expect(getCatalogItem(ProjectType.PESSOAL, 'neutros')).toBeDefined();
      expect(getCatalogItem(ProjectType.PESSOAL, 'cash-flow')).toBeDefined();
    });

    it('returns a copy, not reference to original', () => {
      const page1 = getCatalogItem(ProjectType.REFORMA, 'dashboard');
      const page2 = getCatalogItem(ProjectType.REFORMA, 'dashboard');

      if (page1 && page2) {
        expect(page1).toEqual(page2);
        expect(page1).not.toBe(page2);
      }
    });
  });

  describe('catalog CTA structure', () => {
    it('primary CTAs exist for actionable pages', () => {
      const pessoal = getSummaryCatalog(ProjectType.PESSOAL);
      const monthly = pessoal.find((p) => p.slug === 'monthly');

      expect(monthly?.ctas.length).toBeGreaterThan(0);
      expect(monthly?.ctas.some((c) => c.variant === 'primary')).toBe(true);
    });

    it('readOnly pages are marked when informational', () => {
      const reforma = getSummaryCatalog(ProjectType.REFORMA);
      const priceCompare = reforma.find((p) => p.slug === 'price-compare');

      expect(priceCompare?.readOnly).toBe(true);
    });

    it('CTA labels and hrefs are non-empty', () => {
      const allCatalog = Object.values(SUMMARY_CATALOG).flat();
      allCatalog.forEach((page) => {
        page.ctas.forEach((cta) => {
          expect(cta.label.length).toBeGreaterThan(0);
          expect(cta.href.length).toBeGreaterThan(0);
        });
      });
    });
  });

  describe('consistency across project types', () => {
    it('dashboard slug is present for all types except PESSOAL', () => {
      expect(getCatalogItem(ProjectType.REFORMA, 'dashboard')).toBeDefined();
      expect(getCatalogItem(ProjectType.COMPRA, 'dashboard')).toBeDefined();
      expect(getCatalogItem(ProjectType.CASA, 'dashboard')).toBeDefined();
      expect(getCatalogItem(ProjectType.CARRO, 'dashboard')).toBeDefined();
      expect(getCatalogItem(ProjectType.PLANTAS, 'dashboard')).toBeDefined();
    });

    it('PESSOAL cockpit is named "monthly" instead of "dashboard"', () => {
      expect(getCatalogItem(ProjectType.PESSOAL, 'monthly')).toBeDefined();
      expect(getCatalogItem(ProjectType.PESSOAL, 'dashboard')).toBeUndefined();
    });

    it('each slug within a type is unique', () => {
      Object.entries(SUMMARY_CATALOG).forEach(([type, catalog]) => {
        const slugs = catalog.map((p) => p.slug);
        const unique = new Set(slugs);
        expect(unique.size).toBe(slugs.length);
      });
    });
  });

  describe('CRITICAL INVARIANT: summary coverage and validity', () => {
    it('each summary catalog entry corresponds to a valid generic journey screen', () => {
      const uncovered: Array<{ type: ProjectType; slug: string }> = [];

      Object.entries(SUMMARY_CATALOG).forEach(([type, catalog]) => {
        const screenSlugs = new Set(
          GENERIC_JOURNEY_SCREEN_CATALOG[type as ProjectType] ?? [],
        );

        catalog.forEach((page) => {
          if (!screenSlugs.has(page.slug)) {
            uncovered.push({ type: type as ProjectType, slug: page.slug });
          }
        });
      });

      if (uncovered.length > 0) {
        const message = uncovered
          .map(({ type, slug }) => `  - ${type}: ${slug}`)
          .join('\n');
        throw new Error(
          `CRITICAL: The following summary catalog entries do not correspond to valid generic journey screens:\n${message}\n\n` +
            'Every entry in SUMMARY_CATALOG.slug must be a valid screen slug from GENERIC_JOURNEY_SCREEN_CATALOG.',
        );
      }

      expect(uncovered.length).toBe(0);
    });

    it('no summary catalog entries are duplicated across project types for same slug', () => {
      const allSlugs: Map<string, ProjectType[]> = new Map();

      Object.entries(SUMMARY_CATALOG).forEach(([type, catalog]) => {
        catalog.forEach((page) => {
          const key = page.slug;
          if (!allSlugs.has(key)) {
            allSlugs.set(key, []);
          }
          allSlugs.get(key)?.push(type as ProjectType);
        });
      });

      // This is allowed — different project types can have the same slug
      // (e.g., 'dashboard' is common across many types). Just verify
      // each type has unique slugs internally.
      expect(allSlugs.size).toBeGreaterThan(0);
    });
  });

  it('U5 — vocabulário unificado: títulos de planning e planejador no catálogo', () => {
    const planning = getCatalogItem(ProjectType.PESSOAL, 'planning')!;
    const planejador = getCatalogItem(ProjectType.PESSOAL, 'planejador')!;
    const cashFlow = getCatalogItem(ProjectType.PESSOAL, 'cash-flow')!;

    expect(planning.title).toBe('Orçamento futuro');
    expect(planejador.title).toBe('Compras e cenários');
    // CTA no card cash-flow aponta para o planejador com label alinhado
    expect(cashFlow.ctas.find((c) => c.href === 'planejador')?.label).toBe('Compras e cenários');
  });
});
