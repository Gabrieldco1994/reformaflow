import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { JOURNEY_SAFE_ACTIONS } from '../src/config/journey-catalog';

describe('Journey Action Markers', () => {
  it('should have exactly one CTA marked with each safe action in the codebase', () => {
    const webRoot = join(__dirname, '../../../apps/web/src');
    
    // Fail loudly if web directory doesn't exist — test is broken, not skippable
    if (!existsSync(webRoot)) {
      throw new Error(
        `BROKEN TEST: web root not found at ${webRoot}\n` +
        `The test is unable to scan for CTAs. This path must exist to validate coverage.`
      );
    }

    const CTAsByAction = new Map<string, string[]>();

    // Initialize with all safe actions
    JOURNEY_SAFE_ACTIONS.forEach((action) => {
      CTAsByAction.set(action, []);
    });

    // Walk the web directory and find all elements with data-journey-action
    walkDir(webRoot, (filePath: string) => {
      const content = readFileSync(filePath, 'utf-8');
      
      JOURNEY_SAFE_ACTIONS.forEach((action) => {
        // Match the exact attribute: data-journey-action="value" or data-journey-action='value'
        // Count non-overlapping occurrences of the full attribute reference
        const pattern = `data-journey-action=["']?${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?`;
        const regex = new RegExp(pattern, 'g');
        const matches = content.match(regex);
        
        if (matches && matches.length > 0) {
          const existing = CTAsByAction.get(action) || [];
          // Store both file path AND count to detect duplicates
          existing.push(`${relative(webRoot, filePath)}:${matches.length}`);
          CTAsByAction.set(action, existing);
        }
      });
    });

    // Verify each safe action has exactly one CTA
    const failures: string[] = [];
    CTAsByAction.forEach((entries, action) => {
      if (entries.length === 0) {
        failures.push(`  ❌ ${action}: NO CTA FOUND (expected 1, found 0)`);
      } else if (entries.length > 1) {
        failures.push(
          `  ⚠️  ${action}: DUPLICATED (expected 1, found ${entries.length})\n` +
          `      Locations: ${entries.join('; ')}`
        );
      } else {
        // entries.length === 1, but check if there are multiple occurrences in the file
        const [entry] = entries;
        const [filePath, countStr] = entry.split(':');
        const count = parseInt(countStr, 10) || 1;
        if (count > 1) {
          failures.push(
            `  ⚠️  ${action}: MULTIPLE IN SAME FILE (expected 1, found ${count})\n` +
            `      File: ${filePath}`
          );
        }
      }
    });

    if (failures.length > 0) {
      throw new Error(
        `\nJourney Safe Actions not properly marked:\n${failures.join('\n')}\n\n` +
        `Each safe action must have exactly ONE CTA marked with data-journey-action.`
      );
    }

    // Summary
    console.log(`\n✅ All ${JOURNEY_SAFE_ACTIONS.length} journey safe actions have exactly one CTA marked.`);
  });
});

function walkDir(dir: string, callback: (filePath: string) => void): void {
  try {
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
  } catch (error) {
    // Directory doesn't exist or can't be read
  }
}
