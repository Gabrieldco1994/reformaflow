import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { JOURNEY_SAFE_ACTIONS } from '../src/config/journey-catalog';

// Um destino pode ter mais de um CTA marcado (ex.: botão desktop + FAB mobile
// equivalente para o mesmo `data-journey-action`) — a invariante real é
// cobertura (>=1), não unicidade. Ver A2/A3 do briefing de Fase A.
const DATA_JOURNEY_ACTION_RE = /data-journey-action=["']([^"']+)["']/g;

describe('Journey Action Markers', () => {
  it('every safe action has at least one CTA, and no marker points outside the catalog', () => {
    const webRoot = join(__dirname, '../../../apps/web/src');

    // Fail loudly if web directory doesn't exist — test is broken, not skippable
    if (!existsSync(webRoot)) {
      throw new Error(
        `BROKEN TEST: web root not found at ${webRoot}\n` +
        `The test is unable to scan for CTAs. This path must exist to validate coverage.`
      );
    }

    const knownActions = new Set<string>(JOURNEY_SAFE_ACTIONS);
    const locationsByAction = new Map<string, string[]>();
    const unknownKeys = new Map<string, string[]>();

    walkDir(webRoot, (filePath: string) => {
      // Specs referenciam chaves reais só para simular DOM em teste — não são
      // CTAs de produção e não contam para cobertura nem para chave inválida.
      if (/\.(test|spec)\.tsx?$/.test(filePath)) return;

      const content = readFileSync(filePath, 'utf-8');
      for (const match of content.matchAll(DATA_JOURNEY_ACTION_RE)) {
        const key = match[1];
        const location = relative(webRoot, filePath);
        if (knownActions.has(key)) {
          const existing = locationsByAction.get(key) ?? [];
          existing.push(location);
          locationsByAction.set(key, existing);
        } else {
          const existing = unknownKeys.get(key) ?? [];
          existing.push(location);
          unknownKeys.set(key, existing);
        }
      }
    });

    const failures: string[] = [];

    JOURNEY_SAFE_ACTIONS.forEach((action) => {
      if (!locationsByAction.has(action)) {
        failures.push(`  ❌ ${action}: NO CTA FOUND (expected at least 1, found 0)`);
      }
    });

    unknownKeys.forEach((files, key) => {
      failures.push(
        `  ❌ "${key}" is not in JOURNEY_SAFE_ACTIONS but is used as data-journey-action\n` +
        `      Locations: ${files.join('; ')}`
      );
    });

    if (failures.length > 0) {
      throw new Error(
        `\nJourney Safe Actions coverage problem:\n${failures.join('\n')}\n\n` +
        `Each safe action needs at least one marked CTA, and every marked key must exist in the catalog.`
      );
    }

    console.log(`\n✅ All ${JOURNEY_SAFE_ACTIONS.length} journey safe actions have at least one CTA marked.`);
  });
});

function walkDir(dir: string, callback: (filePath: string) => void): void {
  const files = readdirSync(dir, { withFileTypes: true });

  files.forEach((file) => {
    const fullPath = join(dir, file.name);

    // Skip node_modules, .next, etc.
    if (file.name.startsWith('.') || file.name === 'node_modules' || file.name === '.next') {
      return;
    }

    if (file.isDirectory()) {
      walkDir(fullPath, callback);
    } else if (file.name.endsWith('.tsx') || file.name.endsWith('.ts')) {
      callback(fullPath);
    }
  });
}
