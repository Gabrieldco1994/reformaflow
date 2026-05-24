import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBankAccountDto, UpdateBankAccountDto } from './dto/bank-account.dto';
import { parseBankStatementBuffer, type BankSourceHint } from './parsers';
import type { NormalizedTx } from '../credit-card/parsers/types';
import { categorize } from '../credit-card/categorizer';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';

// Mapeamento categoria → ExpenseType pessoal (mesmo do credit-card)
const PESSOAL_CATEGORY_MAP: Record<string, string> = {
  alimentação: 'ALIMENTACAO',
  transporte: 'TRANSPORTE',
  assinaturas: 'ASSINATURAS',
  viagem: 'LAZER',
  saúde: 'SAUDE',
  compras: 'OUTROS',
  educação: 'EDUCACAO',
  casa: 'MORADIA',
  moradia: 'MORADIA',
  servicos: 'OUTROS',
  beleza: 'OUTROS',
  pets: 'OUTROS',
  impostos: 'OUTROS',
  lazer: 'LAZER',
  investimentos: 'OUTROS',
  transferência: 'TRANSFERENCIA',
  outros: 'OUTROS',
};

/**
 * Heurísticas determinísticas para descrições de extrato que IA não distingue bem.
 * Retorna categoria interna (tipoDespesa) ou null se não aplicável.
 */
function fastClassify(merchant: string): string | null {
  const m = merchant.toUpperCase();
  // PIX entre pessoas físicas / TED → transferência (não é consumo)
  if (/^PIX\s+TRANSF\b/.test(m)) return 'TRANSFERENCIA';
  if (/^PIX\s+CARTAO\b/.test(m)) return 'TRANSFERENCIA';
  if (/^TED\b/.test(m)) return 'TRANSFERENCIA';
  if (/^DOC\b/.test(m)) return 'TRANSFERENCIA';
  if (/\bNU\s+PAGAMENT|NUBANK\b/.test(m)) return 'TRANSFERENCIA';
  // Tarifas bancárias e impostos financeiros
  if (/\bIOF\b|^TARIFA|^TAR\s|JUROS\s+ROTAT/.test(m)) return 'OUTROS';
  // Débitos automáticos de utilities/telco
  if (/\bDA\s+VIVO|\bVIVO-|\bCLARO\b|\bTIM\s|\bOI\s|\bNET\s|\bSKY\s|\bTIMO\b/.test(m)) return 'ASSINATURAS';
  if (/\bENEL\b|\bSABESP\b|\bELETROPAULO\b|\bCOMGAS\b|\bCEMIG\b|\bCOPEL\b|\bLIGHT\b/.test(m)) return 'MORADIA';
  if (/\bIPVA\b|\bIPTU\b|\bDARF\b|\bGPS\b|\bDETRAN\b/.test(m)) return 'OUTROS';
  // PAY xxx — códigos abreviados Itaú; alguns conhecidos:
  if (/^PAY\s+IFD\b|^PAY\s+IFOOD/.test(m)) return 'ALIMENTACAO';
  if (/^PAY\s+UBR\b|^PAY\s+UBER/.test(m)) return 'TRANSPORTE';
  if (/^PAY\s+99\b/.test(m)) return 'TRANSPORTE';
  if (/^PAY\s+RAPPI|^PAY\s+RPP/.test(m)) return 'ALIMENTACAO';
  if (/^PAY\s+(HAVAN|DECAT|LOJAS|SHOPP|RENNER|RIACH|MAGALU|AMERIC|CASAS)/.test(m)) return 'OUTROS'; // compras
  if (/^PAY\s+(DONA|BAR|REST|PIZZA|HAMB|BURGER|CAFE|DOC|PADAR|ACOUG)/.test(m)) return 'ALIMENTACAO';
  if (/^PAY\s+(POSTO|SHELL|IPIRANGA|PETROBR|ULTRA|BR\s)/.test(m)) return 'TRANSPORTE';
  if (/^PAY\s+(FARMA|DROGAS|DROGA|HOSP|CLINIC)/.test(m)) return 'SAUDE';
  // PIX QRS — pagamento via QR Code: Nubank pagamento = transferência
  if (/^PIX\s+QRS\s+(PIX\s+MARKETP|NU\s+PAGAMENT|MERCADO\s*PAGO|MERCADOPAG)/.test(m)) return 'TRANSFERENCIA';
  return null;
}

@Injectable()
export class BankAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly merchantClassifier: MerchantClassifierService,
  ) {}

  // ─── CRUD contas ─────────────────────────────────────────

  async listAccounts(tenantId: string, projectId: string) {
    await this.ensureProject(tenantId, projectId);
    return this.prisma.bankAccount.findMany({
      where: { tenantId, projectId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createAccount(tenantId: string, projectId: string, dto: CreateBankAccountDto) {
    await this.ensureProject(tenantId, projectId);
    const nickname = dto.nickname?.trim() || `${dto.institution} ****${dto.last4}`;
    return this.prisma.bankAccount.create({
      data: { ...dto, nickname, tenantId, projectId },
    });
  }

  async updateAccount(tenantId: string, projectId: string, id: string, dto: UpdateBankAccountDto) {
    await this.findAccount(tenantId, projectId, id);
    const data: Record<string, unknown> = { ...dto };
    if (dto.nickname != null) {
      const t = dto.nickname.trim();
      if (t) data.nickname = t;
      else delete data.nickname;
    }
    await this.prisma.bankAccount.update({ where: { id }, data });
    return this.findAccount(tenantId, projectId, id);
  }

  async deleteAccount(tenantId: string, projectId: string, id: string) {
    await this.findAccount(tenantId, projectId, id);
    await this.prisma.bankAccount.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Imports ─────────────────────────────────────────────

  async listImports(tenantId: string, projectId: string, accountId: string) {
    await this.findAccount(tenantId, projectId, accountId);
    return this.prisma.bankStatementImport.findMany({
      where: { tenantId, accountId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async previewImport(
    tenantId: string,
    projectId: string,
    accountId: string,
    fileContent: string | Buffer,
    fileName: string | undefined,
    source: BankSourceHint,
    password?: string,
  ) {
    const account = await this.findAccount(tenantId, projectId, accountId);
    const buf = typeof fileContent === 'string' ? Buffer.from(fileContent, 'utf-8') : fileContent;
    const parsed = await parseBankStatementBuffer(buf, account.id, source, fileName, password);

    const existing = await this.findExistingExternalIds(
      tenantId,
      projectId,
      parsed.transactions.map((t) => t.externalId),
    );

    const preview = parsed.transactions.map((tx) => {
      const isCardPay = tx.amountCents > 0 && detectCardPayment(tx.merchant).isCardPayment;
      return {
        ...tx,
        date: tx.date.toISOString().slice(0, 10),
        duplicate: existing.has(tx.externalId),
        isCredit: tx.amountCents < 0,
        isCardPayment: isCardPay,
        suggestedCategory: tx.amountCents > 0
          ? (isCardPay ? 'PAGAMENTO_FATURA_CARTAO' : (PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS'))
          : 'RECEITA',
      };
    });

    const debits = parsed.transactions.filter((t) => t.amountCents > 0);
    return {
      source: parsed.source,
      periodLabel: parsed.periodLabel,
      totalAmountCents: debits.reduce((s, t) => s + t.amountCents, 0),
      total: parsed.transactions.length,
      totalDebits: debits.length,
      totalCredits: parsed.transactions.length - debits.length,
      duplicated: preview.filter((p) => p.duplicate).length,
      inserted: 0,
      preview,
    };
  }

  async commitImport(
    tenantId: string,
    projectId: string,
    accountId: string,
    fileContent: string | Buffer,
    fileName: string | undefined,
    source: BankSourceHint,
    periodLabelOverride?: string,
    password?: string,
  ) {
    const account = await this.findAccount(tenantId, projectId, accountId);
    const buf = typeof fileContent === 'string' ? Buffer.from(fileContent, 'utf-8') : fileContent;
    const parsed = await parseBankStatementBuffer(buf, account.id, source, fileName, password);
    const periodLabel = periodLabelOverride ?? parsed.periodLabel ?? new Date().toISOString().slice(0, 7);

    const existingIds = await this.findExistingExternalIds(
      tenantId,
      projectId,
      parsed.transactions.map((t) => t.externalId),
    );

    const toInsert = parsed.transactions.filter((t) => !existingIds.has(t.externalId));
    const duplicated = parsed.transactions.length - toInsert.length;

    const debitsTotal = parsed.transactions
      .filter((t) => t.amountCents > 0)
      .reduce((s, t) => s + t.amountCents, 0);

    const importRecord = await this.prisma.bankStatementImport.create({
      data: {
        tenantId,
        accountId: account.id,
        periodLabel,
        source: parsed.source,
        fileName: fileName?.slice(0, 200),
        fileSize: buf.length,
        status: 'COMPLETED',
        inserted: toInsert.length,
        duplicated,
        totalAmountCents: debitsTotal,
      },
    });

    let inserted = 0;
    let receiptsInserted = 0;
    let cardPayments = 0;
    let skipped = 0;
    for (const tx of toInsert) {
      try {
        const result = await this.createExpenseFromTransaction(tenantId, projectId, account, tx, importRecord.id);
        if (result.inserted) inserted++;
        if (result.receiptInserted) receiptsInserted++;
        if (result.cardPayment) cardPayments++;
      } catch (err) {
        skipped++;
        console.warn(`[bank-import] tx skipped (${tx.externalId.slice(0, 8)}):`, (err as Error).message);
      }
    }

    // ─── Reclassificação inteligente via AI (Gemini) ──────────
    // Para todas as Expenses tipo OUTROS criadas neste import, consulta o
    // classifier (cache DB + Gemini). Atualiza tipoDespesa + categoria do CashFlow.
    const aiReclassified = await this.reclassifyImportedExpenses(tenantId, projectId, importRecord.id);

    await this.prisma.bankStatementImport.update({
      where: { id: importRecord.id },
      data: {
        inserted,
        skipped,
        message: [
          receiptsInserted > 0 ? `${receiptsInserted} recebimento(s)` : null,
          cardPayments > 0 ? `${cardPayments} pagto(s) de cartão vinculado(s)` : null,
          aiReclassified > 0 ? `${aiReclassified} categoria(s) sugerida(s) por IA` : null,
        ].filter(Boolean).join(' • ') || null,
      },
    });

    return {
      importId: importRecord.id,
      source: parsed.source,
      periodLabel,
      totalAmountCents: debitsTotal,
      total: parsed.transactions.length,
      inserted,
      duplicated,
      receiptsInserted,
      cardPayments,
      aiReclassified,
      skipped,
    };
  }

  /**
   * Pega todas as Expenses tipo OUTROS criadas neste import e reclassifica
   * via cache+AI. Atualiza tipoDespesa da Expense + categoria da CashFlowEntry.
   */
  private async reclassifyImportedExpenses(
    tenantId: string,
    projectId: string,
    importId: string,
  ): Promise<number> {
    const candidates = await this.prisma.expense.findMany({
      where: {
        tenantId, projectId, importId,
        tipoDespesa: 'OUTROS',
        deletedAt: null,
      },
      select: { id: true, fornecedor: true },
    });
    if (!candidates.length) return 0;

    const merchants = candidates.map((c) => c.fornecedor || '').filter(Boolean);
    const map = await this.merchantClassifier.classifyBatch(merchants);
    if (!map.size) return 0;

    let updated = 0;
    for (const c of candidates) {
      if (!c.fornecedor) continue;
      const key = MerchantClassifierService.normalizeKey(c.fornecedor);
      const r = map.get(key);
      if (!r) continue;
      const newType = PESSOAL_CATEGORY_MAP[r.category] ?? 'OUTROS';
      if (newType === 'OUTROS') continue;
      await this.prisma.$transaction([
        this.prisma.expense.update({
          where: { id: c.id },
          data: { tipoDespesa: newType },
        }),
        this.prisma.cashFlowEntry.updateMany({
          where: { expenseId: c.id },
          data: { categoria: newType },
        }),
      ]);
      updated++;
    }
    return updated;
  }

  // ─── Links cross-project ─────────────────────────────────

  async suggestLinks(tenantId: string, projectId: string, accountId: string) {
    const account = await this.findAccount(tenantId, projectId, accountId);

    const bankExpenses = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId,
        bankLast4: account.last4,
        linkedExpenseId: null,
        deletedAt: null,
      },
      orderBy: { dataPagamento: 'desc' },
      take: 200,
    });

    if (bankExpenses.length === 0) return [];

    const otherProjects = await this.prisma.project.findMany({
      where: { tenantId, id: { not: projectId }, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    if (otherProjects.length === 0) {
      return bankExpenses.map((e) => ({ expense: serializeExpense(e), suggestions: [] }));
    }

    const otherIds = otherProjects.map((p) => p.id);
    const planned = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId: { in: otherIds },
        status: 'PLANEJADO',
        deletedAt: null,
      },
      take: 500,
      orderBy: { dataInicioParcela: 'desc' },
    });
    const projectById = new Map(otherProjects.map((p) => [p.id, p]));

    return bankExpenses.map((e) => {
      const baseDate = e.dataPagamento ?? e.dataInicioParcela ?? e.createdAt;
      const minDate = new Date(baseDate); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(baseDate); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const tolerance = Math.max(100, Math.round(e.valorTotal * 0.05));

      const matches = planned
        .filter((p) => {
          if (Math.abs(p.valorTotal - e.valorTotal) > tolerance) return false;
          const pDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          return pDate >= minDate && pDate <= maxDate;
        })
        .slice(0, 5)
        .map((p) => ({
          expenseId: p.id,
          projectId: p.projectId,
          projectName: projectById.get(p.projectId)?.name ?? '',
          projectType: projectById.get(p.projectId)?.type ?? '',
          titulo: p.titulo,
          fornecedor: p.fornecedor,
          valor: p.valorTotal,
          data: (p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt).toISOString(),
          deltaCents: e.valorTotal - p.valorTotal,
        }));

      return { expense: serializeExpense(e), suggestions: matches };
    });
  }

  async linkToExpense(
    tenantId: string,
    projectId: string,
    bankExpenseId: string,
    targetExpenseId: string,
  ) {
    const source = await this.prisma.expense.findFirst({
      where: { id: bankExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa importada não encontrada');
    if (!source.bankLast4) throw new BadRequestException('Despesa não foi importada de conta bancária');

    const target = await this.prisma.expense.findFirst({
      where: { id: targetExpenseId, tenantId, deletedAt: null },
    });
    if (!target) throw new NotFoundException('Despesa alvo não encontrada');
    if (target.status === 'PAGO') {
      throw new BadRequestException('Despesa alvo já está paga — desvincule antes de re-linkar');
    }
    if (target.projectId === projectId) {
      throw new BadRequestException('Alvo deve estar em outro projeto');
    }

    const paymentDate = source.dataPagamento ?? source.dataInicioParcela ?? source.createdAt;

    await this.prisma.$transaction([
      this.prisma.expense.update({
        where: { id: target.id },
        data: {
          status: 'PAGO',
          dataPagamento: target.dataPagamento ?? target.dataInicioParcela ?? paymentDate,
        },
      }),
      this.prisma.cashFlowEntry.updateMany({
        where: {
          tenantId,
          expenseId: target.id,
          status: { in: ['PLANEJADO', 'PREVISTO'] },
          deletedAt: null,
        },
        data: { status: 'PAGO' },
      }),
      this.prisma.expense.update({
        where: { id: source.id },
        data: { linkedExpenseId: target.id },
      }),
    ]);

    return { ok: true, sourceId: source.id, targetId: target.id, paymentDate };
  }

  async unlinkExpense(tenantId: string, projectId: string, bankExpenseId: string) {
    const source = await this.prisma.expense.findFirst({
      where: { id: bankExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    if (!source.linkedExpenseId) return { ok: true, alreadyUnlinked: true };
    await this.prisma.expense.update({
      where: { id: source.id },
      data: { linkedExpenseId: null },
    });
    return { ok: true };
  }

  // ─── helpers ─────────────────────────────────────────────

  private async ensureProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  private async findAccount(tenantId: string, projectId: string, id: string) {
    const account = await this.prisma.bankAccount.findFirst({
      where: { id, tenantId, projectId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('Conta bancária não encontrada');
    return account;
  }

  private async findExistingExternalIds(
    tenantId: string,
    projectId: string,
    ids: string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const [expenses, receipts] = await Promise.all([
      this.prisma.expense.findMany({
        where: { tenantId, projectId, externalId: { in: ids }, deletedAt: null },
        select: { externalId: true },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, projectId, externalId: { in: ids }, deletedAt: null },
        select: { externalId: true },
      }),
    ]);
    const set = new Set<string>();
    for (const r of expenses) if (r.externalId) set.add(r.externalId);
    for (const r of receipts) if (r.externalId) set.add(r.externalId);
    return set;
  }

  /**
   * Cria Expense (débito) ou Receipt (crédito) a partir de uma transação de extrato.
   * - amountCents > 0 = débito → Expense (PAGO) + CashFlowEntry DESPESA
   * - amountCents < 0 = crédito → Receipt (EM_CAIXA) + CashFlowEntry RECEBIMENTO
   */
  private async createExpenseFromTransaction(
    tenantId: string,
    projectId: string,
    account: { id: string; nickname: string; last4: string; institution: string },
    tx: NormalizedTx,
    importId: string,
  ): Promise<{ inserted: boolean; receiptInserted: boolean; cardPayment: boolean }> {
    if (tx.amountCents < 0) {
      const receiptAmount = -tx.amountCents;
      const tipoReceipt = classifyCreditType(tx.merchant);
      const receipt = await this.prisma.receipt.create({
        data: {
          tenantId,
          projectId,
          valor: receiptAmount,
          data: tx.date,
          tipo: tipoReceipt,
          status: 'EM_CAIXA',
          descricao: tx.merchant.slice(0, 200),
          importId,
          externalId: tx.externalId,
          bankLast4: account.last4,
        },
      });
      await this.prisma.cashFlowEntry.create({
        data: {
          tenantId,
          projectId,
          receiptId: receipt.id,
          valor: receiptAmount,
          tipo: 'RECEBIMENTO',
          categoria: tipoReceipt,
          subcategoria: account.nickname,
          formaPagamento: 'CONTA_CORRENTE',
          data: tx.date,
          status: 'EM_CAIXA',
        },
      });
      return { inserted: false, receiptInserted: true, cardPayment: false };
    }

    // ─── Detecção de pagamento de fatura de cartão ─────────────
    // Quando o extrato bancário tem uma linha "FATURA PAGA" / "PAGTO CARTAO" /
    // "DEB AUT CARTAO", essa despesa já foi contabilizada pela fatura do cartão
    // de crédito importada. Para evitar dupla contagem no fluxo de caixa:
    //   - Criamos a Expense com tipoDespesa PAGAMENTO_FATURA_CARTAO
    //   - NÃO criamos CashFlowEntry (a fatura já gerou suas próprias DESPESAs)
    //   - Tentamos auto-vincular a um CreditCardStatementImport por valor/data
    const cardPaymentInfo = detectCardPayment(tx.merchant);
    if (cardPaymentInfo.isCardPayment) {
      const matchedCard = await this.findMatchingCreditCard(
        tenantId,
        tx.amountCents,
        tx.date,
        cardPaymentInfo.last4,
      );
      await this.prisma.expense.create({
        data: {
          tenantId,
          projectId,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          titulo: matchedCard
            ? `Pagamento fatura ${matchedCard.nickname}`
            : tx.merchant.slice(0, 200),
          fornecedor: tx.merchant.slice(0, 200),
          valor: tx.amountCents,
          quantidade: 1,
          valorTotal: tx.amountCents,
          formaPagamento: 'A_VISTA',
          dataPagamento: tx.date,
          status: 'PAGO',
          importId,
          externalId: tx.externalId,
          bankLast4: account.last4,
          cardLast4: matchedCard?.last4 ?? cardPaymentInfo.last4 ?? null,
        },
      });
      return { inserted: false, receiptInserted: false, cardPayment: true };
    }

    const expenseType =
      fastClassify(tx.merchant) ??
      (PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS');
    const titulo = tx.merchant.slice(0, 200);

    const expense = await this.prisma.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: expenseType,
        titulo,
        fornecedor: tx.merchant.slice(0, 200),
        valor: tx.amountCents,
        quantidade: 1,
        valorTotal: tx.amountCents,
        formaPagamento: 'A_VISTA',
        dataPagamento: tx.date,
        status: 'PAGO',
        importId,
        externalId: tx.externalId,
        bankLast4: account.last4,
      },
    });

    await this.prisma.cashFlowEntry.create({
      data: {
        tenantId,
        projectId,
        expenseId: expense.id,
        valor: tx.amountCents,
        tipo: 'DESPESA',
        categoria: expenseType,
        subcategoria: account.nickname,
        formaPagamento: 'CONTA_CORRENTE',
        data: tx.date,
        status: 'PAGO',
      },
    });

    return { inserted: true, receiptInserted: false, cardPayment: false };
  }

  /**
   * Tenta achar um CreditCard do tenant para associar a um pagamento de fatura.
   * Estratégia:
   *   1. Se hint de last4 detectado na descrição: match exato.
   *   2. Senão: procurar CreditCardStatementImport com totalAmountCents ≈ amountCents
   *      (±R$ 1) e cuja fatura está num período compatível (até 60 dias antes do pagamento).
   *   3. Senão: qualquer cartão único do tenant (fallback se houver 1 só).
   */
  private async findMatchingCreditCard(
    tenantId: string,
    amountCents: number,
    paymentDate: Date,
    hintLast4: string | null,
  ): Promise<{ id: string; last4: string; nickname: string } | null> {
    if (hintLast4) {
      const byHint = await this.prisma.creditCard.findFirst({
        where: { tenantId, last4: hintLast4, deletedAt: null },
        select: { id: true, last4: true, nickname: true },
      });
      if (byHint) return byHint;
    }

    const sixtyDaysBefore = new Date(paymentDate);
    sixtyDaysBefore.setDate(sixtyDaysBefore.getDate() - 60);
    const tolerance = 200; // R$ 2 de tolerância (encargos podem variar)
    const matchedImport = await this.prisma.creditCardStatementImport.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        createdAt: { gte: sixtyDaysBefore },
        totalAmountCents: { gte: amountCents - tolerance, lte: amountCents + tolerance },
      },
      include: { card: { select: { id: true, last4: true, nickname: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (matchedImport?.card) return matchedImport.card;

    const cards = await this.prisma.creditCard.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, last4: true, nickname: true },
      take: 2,
    });
    if (cards.length === 1) return cards[0];
    return null;
  }
}

/**
 * Detecta se uma linha de extrato é pagamento de fatura de cartão.
 * Retorna also o hint de last4 se aparecer na descrição (ex: "PAGTO CART CRED 1234").
 */
function detectCardPayment(merchant: string): { isCardPayment: boolean; last4: string | null } {
  const m = merchant.toUpperCase();
  // Padrões: "FATURA PAGA", "PAGAMENTO CARTAO CRED", "PAGTO CART CRED", "DEB AUT CART", "DEBITO AUTOM CART"
  const isCardPayment = /(FATURA\s+PAG[AO])|(PAG(AMEN)?TO\s+(DE\s+)?CART(\u00c3O|AO)?\s+CRED)|(PAG(AMEN)?TO\s+(DE\s+)?CART(\u00c3O|AO))|(DEB(ITO)?\s+AUT(OM)?(ATICO|AT)?\s+CART)|(DEBITO\s+AUTOM\s+CART)/i.test(
    m,
  );
  if (!isCardPayment) return { isCardPayment: false, last4: null };
  const last4Match = m.match(/\b(\d{4})\b/);
  return { isCardPayment: true, last4: last4Match ? last4Match[1] : null };
}

/**
 * Classifica o tipo de crédito a partir da descrição do extrato.
 */
function classifyCreditType(merchant: string): string {
  const m = merchant.toUpperCase();
  if (/REMUNERACAO|SALARIO|PAGAMENTO\s+SALARIO/.test(m)) return 'PAGAMENTO';
  if (/REND\s+PAGO|RENDIMENTO|JUROS|DIVIDENDO|RESGATE|COR\s+TES|INT\s+RESGATE|AG\.?\s*RESGATE|CDB/.test(m))
    return 'RENDIMENTO';
  if (/^PIX\s+TRANSF|^TED|^DOC|TRANSFER[EÊ]NCIA|CREDITO\s+LIBERAD/.test(m)) return 'TRANSFERENCIA';
  if (/SISPAG|REEMBOLSO|RESTITUI/.test(m)) return 'PAGAMENTO';
  return 'OUTROS';
}

function serializeExpense(e: {
  id: string; titulo: string | null; fornecedor: string | null;
  valorTotal: number; dataPagamento: Date | null; dataInicioParcela: Date | null;
  createdAt: Date; status: string; bankLast4: string | null;
  formaPagamento: string; linkedExpenseId: string | null; tipoDespesa: string;
}) {
  return {
    id: e.id,
    titulo: e.titulo,
    fornecedor: e.fornecedor,
    valor: e.valorTotal,
    data: (e.dataPagamento ?? e.dataInicioParcela ?? e.createdAt).toISOString(),
    status: e.status,
    bankLast4: e.bankLast4,
    formaPagamento: e.formaPagamento,
    linkedExpenseId: e.linkedExpenseId,
    tipoDespesa: e.tipoDespesa,
  };
}
