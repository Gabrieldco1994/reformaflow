import { describe, it, expect } from 'vitest';
import * as barrel from '../src/index';
import * as contract from '../src/import-session';

/**
 * Bootstrap contract of the import-session wire v1: constants are immutable, the
 * closed enums are identity maps, and everything is reachable from the package barrel
 * (the API consumes `@reformaflow/domain`). Types carry no runtime, so only values here.
 */
describe('import-session wire v1 constants', () => {
  it('freezes limits and primitives so no caller can widen a budget at runtime', () => {
    expect(Object.isFrozen(contract.IMPORT_SESSION_LIMITS)).toBe(true);
    expect(Object.isFrozen(contract.IMPORT_SESSION_PRIMITIVES)).toBe(true);
    expect(() => {
      (
        contract.IMPORT_SESSION_LIMITS as { filesPerSession: number }
      ).filesPerSession = 99;
    }).toThrow(TypeError);
    expect(contract.IMPORT_SESSION_LIMITS.filesPerSession).toBe(10);
  });

  it('pins the protocol identifiers and the SQL-coupled budgets', () => {
    expect(contract.IMPORT_SESSION_PROTOCOL_VERSION).toBe(1);
    expect(contract.IMPORT_SESSION_CONSENT_POLICY_VERSION).toBe(1);
    expect(contract.IMPORT_SESSION_KIND).toBe('CREATE_CARD_PURCHASES');
    expect(contract.IMPORT_SESSION_LIMITS.bytesPerFile).toBe(10 * 1024 * 1024);
    expect(contract.IMPORT_SESSION_LIMITS.bytesPerSession).toBe(
      50 * 1024 * 1024,
    );
    expect(contract.IMPORT_SESSION_LIMITS.filesPerRequest).toBeLessThanOrEqual(
      contract.IMPORT_SESSION_LIMITS.filesPerSession,
    );
    // Session bytes must fit the per-file bound times the per-session file count.
    expect(contract.IMPORT_SESSION_LIMITS.bytesPerSession).toBeLessThanOrEqual(
      contract.IMPORT_SESSION_LIMITS.bytesPerFile *
        contract.IMPORT_SESSION_LIMITS.filesPerSession,
    );
    expect(contract.IMPORT_SESSION_PRIMITIVES.maxRevision).toBe(2 ** 31 - 1);
    expect(contract.IMPORT_SESSION_PRIMITIVES.maxCents).toBe(2 ** 31 - 1);
    expect(contract.IMPORT_SESSION_PRIMITIVES.minCents).toBe(-(2 ** 31 - 1));
  });

  it('keeps every closed enum an identity map with the exact member set', () => {
    const expected: Record<string, string[]> = {
      ImportSessionState: [
        'DRAFT',
        'ANALYZING',
        'NEEDS_INPUT',
        'READY',
        'CONFIRMED',
        'APPLIED',
        'REVIEW_REQUIRED',
        'CANCELLED',
        'EXPIRED',
      ],
      ImportSessionAttachmentState: [
        'RESERVED',
        'UPLOADED',
        'ATTACHED',
        'FAILED',
        'RELEASED',
      ],
      ImportSessionArtifactState: [
        'RAW_READY',
        'ANALYZING',
        'EXTRACTED',
        'FAILED',
        'PURGING',
        'PURGED',
      ],
      ImportSessionDocumentFormat: [
        'CSV',
        'OFX',
        'PDF',
        'XLS',
        'XLSX',
        'PNG',
        'JPEG',
        'WEBP',
      ],
      ImportSessionAmountMeaning: [
        'TOTAL_PURCHASE',
        'INSTALLMENT_CHARGE',
        'UNKNOWN',
      ],
    };
    for (const [name, members] of Object.entries(expected)) {
      const value = (contract as Record<string, unknown>)[name] as Record<
        string,
        string
      >;
      expect(Object.keys(value).sort(), name).toEqual([...members].sort());
      for (const [key, member] of Object.entries(value))
        expect(member, `${name}.${key}`).toBe(key);
    }
    expect(Object.keys(contract.ImportSessionErrorCode)).toHaveLength(18);
    for (const [key, member] of Object.entries(contract.ImportSessionErrorCode))
      expect(member).toBe(key);
    expect(contract.ImportSessionErrorCode.CAPABILITY_DISABLED).toBe(
      'CAPABILITY_DISABLED',
    );
    expect(contract.ImportSessionErrorCode.PROVIDER_UNAVAILABLE).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    expect(contract.ImportSessionErrorCode.MODEL_OUTPUT_INVALID).toBe(
      'MODEL_OUTPUT_INVALID',
    );
  });

  it('re-exports the whole contract from the package barrel without shadowing', () => {
    for (const name of Object.keys(contract))
      expect((barrel as Record<string, unknown>)[name], name).toBe(
        (contract as Record<string, unknown>)[name],
      );
  });
});
