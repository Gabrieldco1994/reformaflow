require('../../../../scripts/test-db-env.cjs');

import { PrismaClient } from '@prisma/client';
import { ExpenseType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { BankImportDecision } from './bank-account.service';
import { BankAccountController } from './bank-account.controller';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import {
  bankOfx, ofxDebit, makeBankAccountService, makeMonthlyOverviewService,
  resetTenant, seedPessoal, seedBankAccount, seedProject,
  seedCardWithClosingDue, seedSinglePurchase,
} from './__tests__/invoice-undo.fixtures';

describe('inline bank expense ownership (#690)', () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const service = makeBankAccountService(prisma);
  const tenantId = 'inline-690-backend';
  const projectId = 'inline-690-pessoal';
  const targetProjectId = 'inline-690-obra';
  const actor = { id: 'inline-690-user', role: 'ADMIN' };
  let accountId: string;
  const file = bankOfx('0690', ofxDebit('20260901', 12345, 'Loja materiais', 'INLINE-690'));

  beforeAll(async () => {
    jest.useFakeTimers({ doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout'] });
    jest.setSystemTime(new Date('2026-09-11T15:00:00Z'));
    await prisma.onModuleInit();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await setup.expense.updateMany({ where: { tenantId }, data: { roomId: null } });
    await setup.room.deleteMany({ where: { project: { tenantId } } });
    await setup.user.deleteMany({ where: { tenantId } });
    await resetTenant(setup, tenantId);
    await seedPessoal(setup, { tenantId, projectId });
    await seedProject(setup, { tenantId, projectId: targetProjectId, type: 'REFORMA', name: 'Obra vazia' });
    await setup.user.create({ data: {
      id: actor.id, tenantId, username: actor.id, name: 'Inline QA', role: 'ADMIN',
      allowedModules: '["expenses","bankAccounts","monthlyOverview"]',
      allowedProjects: JSON.stringify([projectId, targetProjectId]),
      allowedProjectTypes: '["PESSOAL","REFORMA"]',
    } });
    accountId = (await seedBankAccount(setup, { tenantId, projectId, last4: '0690' })).id;
  });
  afterAll(async () => {
    await setup.expense.updateMany({ where: { tenantId }, data: { roomId: null } });
    await setup.room.deleteMany({ where: { project: { tenantId } } });
    await setup.user.deleteMany({ where: { tenantId } });
    await resetTenant(setup, tenantId);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  async function preview() {
    return service.previewImport(tenantId, projectId, accountId, file, 'inline.ofx', 'OFX', undefined, actor);
  }
  async function commit(extra: Record<string, unknown> = {}) {
    const p = await preview();
    const decision = {
      externalId: p.preview[0].externalId, action: 'create',
      newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO', titulo: 'Material da obra' },
      ...extra,
    } as BankImportDecision;
    return service.commitImport(tenantId, projectId, accountId, file, 'inline.ofx', 'OFX',
      '2026-09', undefined, [decision], actor.id, actor);
  }

  it('draft is read-only; creates one full pair and one cash outflow; owned undo is idempotent', async () => {
    const p = await preview();
    expect(p).toMatchObject({ inlineTargetProjects: [{ id: targetProjectId, name: 'Obra vazia', type: 'REFORMA' }] });
    expect(p.preview[0]).toMatchObject({ inlineTargetEligible: true });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
    const result = await commit();
    const expenses = await setup.expense.findMany({ where: { tenantId, deletedAt: null } });
    expect(expenses).toHaveLength(2);
    const source = expenses.find(e => e.projectId === projectId)!;
    const target = expenses.find(e => e.projectId === targetProjectId)!;
    expect(source).toMatchObject({ status: 'PAGO', valorTotal: 12345, bankLast4: '0690', linkedExpenseId: target.id });
    expect(target).toMatchObject({ status: 'PAGO', valorTotal: 12345, bankLast4: null, accountId: null, cardLast4: null, importId: null, externalId: null });
    expect(await setup.rateioAllocation.findMany({ where: { tenantId } })).toMatchObject([
      { sourceExpenseId: source.id, targetExpenseId: target.id, allocation: 12345 },
    ]);
    expect(result).toMatchObject({ inlineExpenses: [{
      sourceExpenseId: source.id, targetExpenseId: target.id, targetProjectId, amountCents: 12345,
    }] });
    const view = await makeMonthlyOverviewService(prisma).getAccountView(tenantId, projectId, '2026-09', actor);
    expect(view.caixaHoje).toBe(-12345);
    expect(view.carteiraHoje).toBe(0);
    expect(view.saiuMes).toBe(12345);
    expect(view.saidaTotal).toBe(12345);
    expect(await service.getImportDetail(tenantId, projectId, accountId, result.importId, actor)).toMatchObject({ canUndo: true });
    await service.undoImport(tenantId, projectId, accountId, result.importId, actor);
    expect(await setup.expense.count({ where: { tenantId, deletedAt: null } })).toBe(0);
    expect(await setup.cashFlowEntry.count({ where: { tenantId, deletedAt: null } })).toBe(0);
    expect(await setup.rateioAllocation.count({ where: { tenantId } })).toBe(0);
    expect(await setup.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    expect(await service.undoImport(tenantId, projectId, accountId, result.importId, actor)).toMatchObject({ alreadyUndone: true });
  });

  it('a descriptive edit blocks the entire undo', async () => {
    const result = await commit();
    const target = await setup.expense.findFirstOrThrow({ where: { tenantId, projectId: targetProjectId } });
    await setup.expense.update({ where: { id: target.id }, data: { titulo: 'Edited later' } });
    const before = await setup.expense.findMany({ where: { tenantId } });
    expect(await service.getImportDetail(tenantId, projectId, accountId, result.importId, actor))
      .toMatchObject({ canUndo: false, blockReason: 'INLINE_IMPORT_DRIFT' });
    await expect(service.undoImport(tenantId, projectId, accountId, result.importId, actor))
      .rejects.toMatchObject({ status: 409 });
    expect(await setup.expense.findMany({ where: { tenantId } })).toEqual(before);
  });

  it('does not trust generated identities or amount supplied in newTarget', async () => {
    await expect(commit({ newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO', amountCents: 1, generated: true } }))
      .rejects.toMatchObject({ status: 400 });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
  });

  it.each(['id', 'snapshot', 'quantity', 'status', 'accountId', 'valor', 'createdByUserId'])('rejects forged newTarget.%s', async key => {
    await expect(commit({ newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO', [key]: 'forged' } }))
      .rejects.toMatchObject({ status: 400 });
    expect(await setup.bankStatementImport.count({ where: { tenantId } })).toBe(0);
  });

  it('rejects multipart non-array JSON and contradictory existing links', async () => {
    const controller = new BankAccountController(service);
    const upload = { buffer: file, originalname: 'inline.ofx' } as Express.Multer.File;
    await expect(controller.importStatement(tenantId, actor, projectId, accountId, [upload],
      { mode: 'commit', source: 'OFX' }, { decisions: '{"newTarget":{}}' })).rejects.toMatchObject({ status: 400 });
    await expect(commit({ linkToExpenseId: 'forged' })).rejects.toMatchObject({ status: 400 });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
  });

  it('authorizes rooms against the destination, not the source', async () => {
    const room = await setup.room.create({ data: { projectId, name: 'Wrong project' } });
    await expect(commit({ newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO', roomId: room.id } }))
      .rejects.toMatchObject({ status: 404 });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
  });

  it('skip and strong dedupe never create another destination', async () => {
    expect(await commit({ action: 'skip' })).toMatchObject({ inlineExpenses: [] });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
    await commit();
    expect(await commit()).toMatchObject({ inlineExpenses: [], inserted: 0 });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(2);
  });

  it('two concurrent confirmations leave at most one pair and no orphan', async () => {
    const outcomes = await Promise.allSettled([commit(), commit()]);
    expect(outcomes.some(o => o.status === 'fulfilled')).toBe(true);
    expect(await setup.expense.count({ where: { tenantId } })).toBe(2);
    expect(await setup.rateioAllocation.count({ where: { tenantId } })).toBe(1);
    expect(await setup.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('a rateio failure rolls back the whole core, including earlier ordinary rows', async () => {
    const statement = bankOfx('0690',
      ofxDebit('20260901', 6789, 'Other purchase', 'FIRST-690'),
      ofxDebit('20260901', 12345, 'Loja materiais', 'SECOND-690'));
    const p = await service.previewImport(tenantId, projectId, accountId, statement, 'fault.ofx', 'OFX', undefined, actor);
    const fault = jest.spyOn(ConciliacaoService.prototype, 'ratearSource').mockRejectedValueOnce(new Error('rateio core failed'));
    await expect(service.commitImport(tenantId, projectId, accountId, statement, 'fault.ofx', 'OFX', '2026-09', undefined, [{
      externalId: p.preview[1].externalId, action: 'create', newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO' },
    }], actor.id, actor)).rejects.toThrow('rateio core failed');
    expect(fault).toHaveBeenCalledTimes(1);
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
    expect(await setup.bankStatementImport.count({ where: { tenantId } })).toBe(0);
    expect(await setup.cashFlowEntry.count({ where: { tenantId } })).toBe(0);
  });

  it.each([
    ['credit', '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260901</DTPOSTED><TRNAMT>123.45</TRNAMT><FITID>CREDIT</FITID><MEMO>Loja</MEMO></STMTTRN>'],
    ['neutral', ofxDebit('20260901', 12345, 'Resgate cofrinho', 'NEUTRAL')],
    ['investment', ofxDebit('20260901', 12345, 'Aplicacao CDB', 'INVEST')],
    ['invoice', ofxDebit('20260901', 12345, 'PAGTO CART CRED 9999', 'INVOICE')],
    ['installment', ofxDebit('20260901', 12345, 'Loja materiais Parcela 1/3', 'INSTALLMENT')],
  ])('rejects %s even with ordinary category and title overrides', async (_kind, transaction) => {
    const statement = bankOfx('0690', transaction);
    const p = await service.previewImport(tenantId, projectId, accountId, statement, 'invalid.ofx', 'OFX', undefined, actor);
    await expect(service.commitImport(tenantId, projectId, accountId, statement, 'invalid.ofx', 'OFX', '2026-09', undefined, [{
      externalId: p.preview[0].externalId, action: 'create', newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO' },
      overrides: { titulo: 'Loja materiais', category: 'OUTROS' },
    }], actor.id, actor)).rejects.toMatchObject({ status: 400 });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
  });

  it('re-reads current grants inside the commit transaction instead of the stale ADMIN claim', async () => {
    const p = await preview();
    await setup.user.update({ where: { id: actor.id }, data: { role: 'USER', allowedProjects: JSON.stringify([projectId]) } });
    let observed = false;
    prisma.$use(async (params, next) => {
      if (params.model === 'User' && params.action === 'findUnique' && params.runInTransaction) observed = true;
      return next(params);
    });
    await expect(service.commitImport(tenantId, projectId, accountId, file, 'inline.ofx', 'OFX', '2026-09', undefined, [{
      externalId: p.preview[0].externalId, action: 'create', newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO' },
    }], actor.id, actor)).rejects.toMatchObject({ status: 404 });
    expect(observed).toBe(true);
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
  });

  it('a later grant revocation takes precedence over drift in detail and undo', async () => {
    const result = await commit();
    await setup.expense.updateMany({ where: { tenantId, projectId: targetProjectId }, data: { titulo: 'drift' } });
    await setup.user.update({ where: { id: actor.id }, data: { role: 'USER', allowedProjects: JSON.stringify([projectId]) } });
    for (const call of [
      () => service.getImportDetail(tenantId, projectId, accountId, result.importId, actor),
      () => service.undoImport(tenantId, projectId, accountId, result.importId, actor),
    ]) await expect(call()).rejects.toMatchObject({ status: 404, message: 'Recurso não encontrado' });
    expect(await setup.expense.count({ where: { tenantId, deletedAt: null } })).toBe(2);
  });

  it.each(['not json', '{"version":2,"creations":[]}', '{"version":1,"creations":[{}]}'])('corrupt provenance fails closed: %s', async raw => {
    const result = await commit();
    await setup.bankStatementImport.update({ where: { id: result.importId }, data: { inlineExpenseCreations: raw } });
    expect(await service.getImportDetail(tenantId, projectId, accountId, result.importId, actor))
      .toMatchObject({ canUndo: false, blockReason: 'INLINE_IMPORT_DRIFT' });
    await expect(service.undoImport(tenantId, projectId, accountId, result.importId, actor)).rejects.toMatchObject({ status: 409 });
    expect(await setup.expense.count({ where: { tenantId, deletedAt: null } })).toBe(2);
  });

  it.each(['target', 'allocation'])('missing %s does not erase durable ownership proof', async missing => {
    const result = await commit();
    const target = await setup.expense.findFirstOrThrow({ where: { tenantId, projectId: targetProjectId } });
    await setup.rateioAllocation.deleteMany({ where: { tenantId } });
    if (missing === 'target') {
      await setup.cashFlowEntry.deleteMany({ where: { tenantId, expenseId: target.id } });
      await setup.expense.delete({ where: { id: target.id } });
    }
    expect(await service.getImportDetail(tenantId, projectId, accountId, result.importId, actor))
      .toMatchObject({ canUndo: false, blockReason: 'INLINE_IMPORT_DRIFT' });
    await setup.user.update({ where: { id: actor.id }, data: { role: 'USER', allowedProjects: JSON.stringify([projectId]) } });
    await expect(service.undoImport(tenantId, projectId, accountId, result.importId, actor)).rejects.toMatchObject({ status: 404 });
  });

  it('mixed settled invoice + inline drift attempts zero writes', async () => {
    await seedCardWithClosingDue(setup, { tenantId, projectId, last4: '6890', closingDay: 25, dueDay: 5 });
    await seedSinglePurchase(setup, {
      tenantId, projectId, cardLast4: '6890', valorCents: 20000,
      data: new Date('2026-08-10T00:00:00Z'), status: 'PLANEJADO',
    });
    const statement = bankOfx('0690',
      ofxDebit('20260828', 20000, 'PAGTO CART CRED 6890', 'MIX-INVOICE'),
      ofxDebit('20260901', 12345, 'Loja materiais', 'MIX-INLINE'));
    const p = await service.previewImport(tenantId, projectId, accountId, statement, 'mixed.ofx', 'OFX', undefined, actor);
    const result = await service.commitImport(tenantId, projectId, accountId, statement, 'mixed.ofx', 'OFX', '2026-09', undefined, [{
      externalId: p.preview[1].externalId, action: 'create', newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO' },
    }], actor.id, actor);
    expect(await setup.importedInvoiceLiquidation.count({ where: { tenantId, deletedAt: null } })).toBe(1);
    await setup.expense.updateMany({ where: { tenantId, projectId: targetProjectId }, data: { titulo: 'changed' } });
    let watching = true;
    const writes: string[] = [];
    prisma.$use(async (params, next) => {
      if (watching && /^(create|update|delete|upsert|executeRaw)/.test(params.action)) writes.push(params.action);
      return next(params);
    });
    try {
      await expect(service.undoImport(tenantId, projectId, accountId, result.importId, actor)).rejects.toMatchObject({ status: 409 });
      expect(writes).toEqual([]);
    } finally { watching = false; }
    expect(await setup.importedInvoiceLiquidation.count({ where: { tenantId, deletedAt: null } })).toBe(1);
  });

  it('post-core failure returns an honest warning, never a fake rollback', async () => {
    jest.spyOn(MerchantClassifierService.prototype, 'learnFromImportOverrides').mockRejectedValueOnce(new Error('offline'));
    const result = await commit();
    expect(result).toMatchObject({ inserted: 1, postCommitWarnings: [{ code: 'CATEGORY_LEARNING_FAILED' }] });
    expect(JSON.stringify(result)).not.toMatch(/snapshot|inlineExpenseCreations/);
    expect(JSON.stringify(await service.listImports(tenantId, projectId, accountId))).not.toMatch(/snapshot|inlineExpenseCreations/);
    expect(await service.getImportDetail(tenantId, projectId, accountId, result.importId, actor)).toMatchObject({ canUndo: true });
  });

  it('uses the full positive effective amount, not a client target amount', async () => {
    const result = await commit({ overrides: { valorCents: 23456 } });
    expect(result.inlineExpenses[0].amountCents).toBe(23456);
    expect((await setup.expense.findMany({ where: { tenantId } })).map(e => e.valorTotal)).toEqual([23456, 23456]);
    expect(await setup.rateioAllocation.findFirst({ where: { tenantId } })).toMatchObject({ allocation: 23456 });
    expect((await makeMonthlyOverviewService(prisma).getAccountView(tenantId, projectId, '2026-09', actor)).caixaHoje).toBe(-23456);
  });

  it('blocks an INVESTIMENTOS rule re-read inside the transaction', async () => {
    jest.spyOn(MerchantClassifierService.prototype, 'manualExpenseType').mockResolvedValue(ExpenseType.INVESTIMENTOS);
    await expect(commit()).rejects.toMatchObject({ status: 400 });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
  });

  it('Tier B force-import is still import-only, never inline creation', async () => {
    const p = await preview();
    await service.commitImport(tenantId, projectId, accountId, file, 'first.ofx', 'OFX', '2026-09', undefined, undefined, actor.id, actor);
    const second = bankOfx('0690', ofxDebit('20260901', 12345, 'Loja materiais', 'DIFFERENT-FITID'));
    const next = await service.previewImport(tenantId, projectId, accountId, second, 'second.ofx', 'OFX', undefined, actor);
    expect(next.preview[0].externalId).not.toBe(p.preview[0].externalId);
    expect(next.preview[0].possibleDuplicate).toBeDefined();
    for (const action of ['create', 'import'] as const) {
      await expect(service.commitImport(tenantId, projectId, accountId, second, 'second.ofx', 'OFX', '2026-09', undefined, [{
        externalId: next.preview[0].externalId, action, newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO' },
      }], actor.id, actor)).rejects.toMatchObject({ status: 400 });
    }
    expect(await service.commitImport(tenantId, projectId, accountId, second, 'second.ofx', 'OFX', '2026-09', undefined, [{
      externalId: next.preview[0].externalId, action: 'import',
    }], actor.id, actor)).toMatchObject({ inserted: 1, inlineExpenses: [] });
    expect(await setup.expense.count({ where: { tenantId, projectId: targetProjectId } })).toBe(0);
  });

  it('a duplicated decision cannot override an inline draft in the map', async () => {
    const p = await preview();
    await expect(service.commitImport(tenantId, projectId, accountId, file, 'inline.ofx', 'OFX', '2026-09', undefined, [
      { externalId: p.preview[0].externalId, newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO' } },
      { externalId: p.preview[0].externalId, action: 'create' },
    ], actor.id, actor)).rejects.toMatchObject({ status: 400 });
  });

  it('preview offers empty authorized expense projects, not hidden or incapable projects', async () => {
    await seedProject(setup, { tenantId, projectId: 'inline-690-hidden', type: 'REFORMA', name: 'Hidden sentinel' });
    await seedProject(setup, { tenantId, projectId: 'inline-690-plants', type: 'PLANTAS', name: 'Plants sentinel' });
    const restricted = {
      id: actor.id, role: 'USER', allowedProjects: [projectId, targetProjectId, 'inline-690-plants'],
      allowedProjectTypes: ['PESSOAL', 'REFORMA', 'PLANTAS'], allowedModules: ['expenses', 'bankAccounts', 'plants'],
    };
    const p = await service.previewImport(tenantId, projectId, accountId, file, 'inline.ofx', 'OFX', undefined, restricted);
    expect(p.inlineTargetProjects).toEqual([{ id: targetProjectId, name: 'Obra vazia', type: 'REFORMA' }]);
    expect(JSON.stringify(p)).not.toContain('sentinel');
    await setup.project.update({ where: { id: projectId }, data: { type: 'REFORMA' } });
    const otherSource = await preview();
    expect(otherSource.inlineTargetProjects).toEqual([]);
    expect(otherSource.preview[0].inlineTargetEligible).toBe(false);
    await expect(commit()).rejects.toMatchObject({ status: 400 });
  });

  it.each(['room', 'value', 'status', 'financial-dependency', 're-rateio'])('blocks later %s drift without partial undo', async change => {
    const result = await commit();
    const target = await setup.expense.findFirstOrThrow({ where: { tenantId, projectId: targetProjectId } });
    if (change === 'room') {
      const room = await setup.room.create({ data: { projectId: targetProjectId, name: 'Room after import' } });
      await setup.expense.update({ where: { id: target.id }, data: { roomId: room.id } });
    } else if (change === 'value') {
      await setup.expense.update({ where: { id: target.id }, data: { valor: 1, valorTotal: 1 } });
    } else if (change === 'status') {
      await setup.expense.update({ where: { id: target.id }, data: { status: 'PLANEJADO' } });
    } else if (change === 'financial-dependency') {
      await setup.expense.create({ data: {
        tenantId, projectId: targetProjectId, tipoDespesa: 'OUTROS', valor: 10, valorTotal: 10,
        formaPagamento: 'A_VISTA', linkedExpenseId: target.id,
      } });
    } else {
      await setup.rateioAllocation.update({ where: { targetExpenseId: target.id }, data: { allocation: 1 } });
    }
    const before = await setup.expense.findMany({ where: { tenantId } });
    expect(await service.getImportDetail(tenantId, projectId, accountId, result.importId, actor))
      .toMatchObject({ canUndo: false, blockReason: 'INLINE_IMPORT_DRIFT' });
    await expect(service.undoImport(tenantId, projectId, accountId, result.importId, actor)).rejects.toMatchObject({ status: 409 });
    expect(await setup.expense.findMany({ where: { tenantId } })).toEqual(before);
  });

  it('mixed existing association undo preserves the pre-existing destination', async () => {
    const planned = await setup.expense.create({ data: {
      tenantId, projectId: targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO',
      titulo: 'Pre-existing', valor: 6789, valorTotal: 6789, formaPagamento: 'A_VISTA',
      status: 'PLANEJADO', dataPagamento: new Date('2026-09-01'),
    } });
    const statement = bankOfx('0690',
      ofxDebit('20260901', 6789, 'Existing material', 'EXISTING-LINK'),
      ofxDebit('20260901', 12345, 'Loja materiais', 'NEW-LINK'));
    const p = await service.previewImport(tenantId, projectId, accountId, statement, 'mixed.ofx', 'OFX', undefined, actor);
    const result = await service.commitImport(tenantId, projectId, accountId, statement, 'mixed.ofx', 'OFX', '2026-09', undefined, [
      { externalId: p.preview[0].externalId, action: 'link', linkToExpenseId: planned.id },
      { externalId: p.preview[1].externalId, action: 'create', newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO' } },
    ], actor.id, actor);
    expect(result).toMatchObject({ linked: 1 });
    expect(await service.getImportDetail(tenantId, projectId, accountId, result.importId, actor)).toMatchObject({ canUndo: true });
    await service.undoImport(tenantId, projectId, accountId, result.importId, actor);
    const remaining = await setup.expense.findMany({ where: { tenantId, deletedAt: null } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: planned.id, status: 'PLANEJADO', valorTotal: 6789 });
  });

  it('invalid persisted grants fail closed even for an ADMIN JWT', async () => {
    const p = await preview();
    await setup.user.update({ where: { id: actor.id }, data: { allowedProjects: 'not-json' } });
    await expect(service.commitImport(tenantId, projectId, accountId, file, 'inline.ofx', 'OFX', '2026-09', undefined, [{
      externalId: p.preview[0].externalId, action: 'create', newTarget: { targetProjectId, tipoDespesa: 'MATERIAL_CONSTRUCAO' },
    }], actor.id, actor)).rejects.toMatchObject({ status: 401 });
    expect(await setup.expense.count({ where: { tenantId } })).toBe(0);
  });
});
