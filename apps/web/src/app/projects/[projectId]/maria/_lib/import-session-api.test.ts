import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

import * as importApi from './import-session-api';
import { receiptFixture, summaryFixture, viewFixture } from './import-session-fixtures';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('one list GET with independent page and entry outcomes', () => {
  const page = () => ({
    items: [summaryFixture()],
    nextCursor: 'signed+cursor/=',
  });

  describe('PublicEntry strict catalog and operational recovery actions', () => {
    const card = {
      id: 'card-a',
      nickname: 'Viagem',
      last4: '1234',
      project: { id: 'owner-a', name: 'Casa', type: 'CASA' },
    };
    it('keeps explicit card IDs and their owners even when last4 collides', async () => {
      const cards = [card, { ...card, id: 'card-b', project: { id: 'owner-b', name: 'Pessoal' } }];
      get.mockResolvedValue(cards);
      expect(await importApi.listImportEntryCards()).toEqual(cards);
      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith('/tenant/credit-cards', {
        signal: undefined,
      });
    });
    it.each([
      null,
      {},
      [{ ...card, project: null }],
      [{ ...card, id: '' }],
      [card, card],
      [{ ...card, project: { id: 'owner-a', name: '' } }],
    ])('rejects a malformed authorized catalog explicitly: %j', async (cards) => {
      get.mockResolvedValue(cards);
      await expect(importApi.listImportEntryCards()).rejects.toBeInstanceOf(importApi.ImportMalformedResponseError);
    });
    it('does not reduce catalog failure to an empty list', async () => {
      const error = new Error('Forbidden');
      get.mockRejectedValue(error);
      await expect(importApi.listImportEntryCards()).rejects.toBe(error);
    });
    it('preserves server ANALYZE in an otherwise valid recovery summary', async () => {
      const row = summaryFixture({ actions: ['ANALYZE', 'CANCEL'] });
      get.mockResolvedValue({
        items: [row],
        nextCursor: null,
        entry: {
          version: 1,
          kind: 'UNAVAILABLE',
          reason: 'NOT_ENABLED',
        },
      });
      expect(await importApi.listImportSessions('active')).toMatchObject({
        page: { items: [row] },
      });
    });
  });

  it.each([
    ['disabled', { version: 1, kind: 'UNAVAILABLE', reason: 'NOT_ENABLED' }],
    ['temporarily unavailable', { version: 1, kind: 'UNAVAILABLE', reason: 'RUNTIME_UNAVAILABLE' }],
    ['without a qualified format', { version: 1, kind: 'UNAVAILABLE', reason: 'NO_QUALIFIED_FORMAT' }],
    [
      'synthetic positive, not runtime availability',
      {
        version: 1,
        kind: 'CARD_INVOICE',
        formats: ['CSV'],
      },
    ],
  ])('returns the page and a VALID entry for %s', async (_name, entry) => {
    const recovery = page();
    get.mockResolvedValue({ ...recovery, entry });
    await expect(importApi.listImportSessions('active')).resolves.toEqual({
      page: recovery,
      entry: { kind: 'VALID', value: entry },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('valid_recovery_page_survives_missing_entry_without_enabling_intake', async () => {
    const recovery = page();
    get.mockResolvedValue(recovery);
    await expect(importApi.listImportSessions('active')).resolves.toEqual({
      page: recovery,
      entry: { kind: 'ERROR', code: 'MISSING_ENTRY' },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['reasonless unavailable', { version: 1, kind: 'UNAVAILABLE' }],
    ['wrong unavailable version', { version: 2, kind: 'UNAVAILABLE', reason: 'NOT_ENABLED' }],
    ['unknown unavailable reason', { version: 1, kind: 'UNAVAILABLE', reason: 'MAINTENANCE' }],
    ['lowercase unavailable reason', { version: 1, kind: 'UNAVAILABLE', reason: 'not_enabled' }],
    ['null unavailable reason', { version: 1, kind: 'UNAVAILABLE', reason: null }],
    [
      'extra unavailable key',
      {
        version: 1,
        kind: 'UNAVAILABLE',
        reason: 'NOT_ENABLED',
        retryable: false,
      },
    ],
    ['unknown kind', { kind: 'UPLOAD' }],
    ['missing formats', { version: 1, kind: 'CARD_INVOICE' }],
    ['wrong card version', { version: 2, kind: 'CARD_INVOICE', formats: ['CSV'] }],
    [
      'extra card key',
      {
        version: 1,
        kind: 'CARD_INVOICE',
        formats: ['CSV'],
        nonce: 'client-must-not-accept-this',
      },
    ],
    ['empty formats', { version: 1, kind: 'CARD_INVOICE', formats: [] }],
    ['duplicate formats', { version: 1, kind: 'CARD_INVOICE', formats: ['CSV', 'CSV'] }],
    ['non-array formats', { version: 1, kind: 'CARD_INVOICE', formats: 'CSV' }],
    ['multiple release formats', { version: 1, kind: 'CARD_INVOICE', formats: ['CSV', 'PDF'] }],
    ['outside the accepted entry formats', { version: 1, kind: 'CARD_INVOICE', formats: ['PNG'] }],
  ])('valid_recovery_page_survives_invalid_entry_without_enabling_intake: %s', async (_name, entry) => {
    const recovery = page();
    get.mockResolvedValue({ ...recovery, entry });
    await expect(importApi.listImportSessions('active')).resolves.toEqual({
      page: recovery,
      entry: { kind: 'ERROR', code: 'INVALID_ENTRY' },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    { items: null, nextCursor: null },
    { items: [null], nextCursor: null },
    { items: [], nextCursor: 42 },
  ])('still rejects the whole invalid page: %j', async (recovery) => {
    get.mockResolvedValue({
      ...recovery,
      entry: {
        version: 1,
        kind: 'UNAVAILABLE',
        reason: 'NOT_ENABLED',
      },
    });
    await expect(importApi.listImportSessions('active')).rejects.toBeInstanceOf(importApi.ImportMalformedResponseError);
  });
});

describe('import-session api client', () => {
  it('keeps recovery and inactive workflow exports with intake and explicit documentary analysis', () => {
    expect(
      Object.keys(importApi)
        .filter((key) => typeof (importApi as Record<string, unknown>)[key] === 'function')
        .sort(),
    ).toEqual([
      'ImportMalformedResponseError',
      'analyzeImportAttachment',
      'cancelImportSession',
      'challengeImportSession',
      'confirmImportSession',
      'continueImportAnswering',
      'createImportSession',
      'declareImportAnswer',
      'deferImportLine',
      'editImportSession',
      'executeConfirmedCurrentLot',
      'executeImportSession',
      'getFullImportSession',
      'getImportCandidates',
      'getImportCurrentLot',
      'getImportObservations',
      'getImportResult',
      'getImportSession',
      'interpretImportAnswer',
      'listImportEntryCards',
      'listImportSessions',
      'prepareImportCurrentLot',
      'prepareImportSession',
      'reactivateImportLine',
      'reserveImportSessionAttachments',
      'resolveImportAnswer',
      'sendImportChat',
      'uploadImportSessionAttachment',
    ]);
  });

  it('lists with state and an encoded cursor, without the UI header', async () => {
    get.mockResolvedValue({ items: [summaryFixture()], nextCursor: 'a+b/c=' });
    const page = await importApi.listImportSessions('active', 'a+b/c=');
    expect(get).toHaveBeenCalledWith('/import-sessions?state=active&cursor=a%2Bb%2Fc%3D');
    expect(page.page.nextCursor).toBe('a+b/c=');
    get.mockResolvedValue({ items: [], nextCursor: null });
    await importApi.listImportSessions('applied');
    expect(get).toHaveBeenLastCalledWith('/import-sessions?state=applied');
  });

  it('returns a fresh empty page as empty, but a malformed 200 as an error', async () => {
    get.mockResolvedValue({
      items: [],
      nextCursor: null,
      entry: { version: 1, kind: 'UNAVAILABLE', reason: 'NOT_ENABLED' },
    });
    await expect(importApi.listImportSessions('active')).resolves.toEqual({
      page: { items: [], nextCursor: null },
      entry: {
        kind: 'VALID',
        value: { version: 1, kind: 'UNAVAILABLE', reason: 'NOT_ENABLED' },
      },
    });
    for (const bad of [
      null,
      {},
      { items: 'x', nextCursor: null },
      { items: [{ id: 1 }], nextCursor: null },
      { items: [], nextCursor: 3 },
    ]) {
      get.mockResolvedValue(bad);
      await expect(importApi.listImportSessions('active')).rejects.toBeInstanceOf(
        importApi.ImportMalformedResponseError,
      );
    }
  });

  it('reads a session and a result by encoded id without the UI header', async () => {
    get.mockResolvedValueOnce(viewFixture());
    await importApi.getImportSession('s/1');
    expect(get).toHaveBeenLastCalledWith('/import-sessions/s%2F1');
    get.mockResolvedValueOnce({ state: 'APPLIED', receipt: receiptFixture() });
    await importApi.getImportResult('s1');
    expect(get).toHaveBeenLastCalledWith('/import-sessions/s1/result');
  });

  it('rejects a session view or result with the wrong shape', async () => {
    get.mockResolvedValueOnce({
      id: 's',
      state: 'BOGUS',
      revision: 1,
      actions: [],
    });
    await expect(importApi.getImportSession('s')).rejects.toBeInstanceOf(importApi.ImportMalformedResponseError);
    get.mockResolvedValueOnce({
      state: 'APPLIED',
      receipt: { snapshot: null },
    });
    await expect(importApi.getImportResult('s')).rejects.toBeInstanceOf(importApi.ImportMalformedResponseError);
  });

  it('cancels with expectedRevision and the UI marker header', async () => {
    post.mockResolvedValue(viewFixture({ state: 'CANCELLED', actions: [] }));
    const view = await importApi.cancelImportSession('s1', 7);
    expect(post).toHaveBeenCalledWith(
      '/import-sessions/s1/cancel',
      { expectedRevision: 7 },
      { headers: { 'x-rf-import-ui': '1' } },
    );
    expect(view.state).toBe('CANCELLED');
  });
});
