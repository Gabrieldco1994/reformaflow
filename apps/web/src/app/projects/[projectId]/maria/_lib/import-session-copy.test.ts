import { describe, expect, it } from 'vitest';
import { IMPORT_STATE_LABEL, importActionGate } from './import-session-copy';

describe('import session copy', () => {
  it('labels exactly the nine wire states', () => {
    expect(Object.keys(IMPORT_STATE_LABEL).sort()).toEqual(
      ['ANALYZING', 'APPLIED', 'CANCELLED', 'CONFIRMED', 'DRAFT', 'EXPIRED', 'NEEDS_INPUT', 'READY', 'REVIEW_REQUIRED'].sort(),
    );
    for (const label of Object.values(IMPORT_STATE_LABEL)) expect(label).not.toMatch(/^[A-Z_]+$/);
  });

  it('only ever offers cancel and result, and only when the server lists them', () => {
    expect(importActionGate(['CANCEL'])).toEqual({ canCancel: true, canReadResult: false });
    expect(importActionGate(['READ_RESULT'])).toEqual({ canCancel: false, canReadResult: true });
    expect(importActionGate([])).toEqual({ canCancel: false, canReadResult: false });
    expect(importActionGate(['UPLOAD', 'RESOLVE', 'PREPARE', 'CONFIRM', 'EXECUTE'])).toEqual({
      canCancel: false,
      canReadResult: false,
    });
  });
});
