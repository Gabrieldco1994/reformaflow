import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { JOURNEY_SAFE_ACTIONS } from '../src/config/journey-catalog';

describe('Journey Action Markers', () => {
  it('should have exactly one CTA marked with each safe action in the codebase', () => {
    const webRoot = join(__dirname, '../../../apps/web/src');
    
    // Skip test if web directory doesn't exist (running in isolation)
    if (!existsSync(webRoot)) {
      console.log(`⏭️  Skipping test: web root not found at ${webRoot}`);
      return;
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
        const regex = new RegExp(`data-journey-action=["']?${action}["']?`, 'g');
        const matches = content.match(regex);
        if (matches) {
          const existing = CTAsByAction.get(action) || [];
          existing.push(`${relative(webRoot, filePath)}`);
          CTAsByAction.set(action, existing);
        }
      });
    });

    // Verify each safe action has exactly one CTA
    const failures: string[] = [];
    CTAsByAction.forEach((files, action) => {
      if (files.length === 0) {
        failures.push(`  ❌ ${action}: NOT FOUND (0 occurrences)`);
      } else if (files.length > 1) {
        failures.push(`  ⚠️  ${action}: MULTIPLE (${files.length} occurrences)`);
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
