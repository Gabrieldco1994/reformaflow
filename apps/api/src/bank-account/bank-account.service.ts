import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBankAccountDto, UpdateBankAccountDto } from './dto/bank-account.dto';
import { parseBankStatementBuffer, type BankSourceHint } from './parsers';
import type { NormalizedTx } from '../credit-card/parsers/types';
import { categorize } from '../credit-card/categorizer';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';

export interface BankImportDecision {
  externalId: string;
  action?: 'create' | 'skip' | 'link';
  linkToExpenseId?: string;
  linkToReceiptId?: string;
  overrides?: {
    titulo?: string;
    valorCents?: number;
    category?: string;
  };
}

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
export function fastClassify(merchant: string): string | null {
  const m = merchant.toUpperCase();
  // GUARD: juros, rendimentos, dividendos NUNCA são movimentação interna —
  // são receita real (precisam virar Receipt RENDIMENTO). Esse check vem
  // ANTES da detecção de mov-interna para evitar que tokens "POUPANCA"/"CDB"
  // dentro de "REND PAGO CDB"/"RENDIMENTO POUPANCA" sejam mal classificados.
  if (/\bREND(IMENTO)?\s+PAG|\bRENDIMENTO\b|\bJUROS\b|\bDIVIDENDO|\bSALARIO\b/i.test(m)) return null;
  // Movimentação interna (aplicações/resgates/cofrinhos/poupança etc.) — saída
  // ou entrada que reflete movimento dentro das contas próprias, não consumo nem
  // receita nova. Usa \b para evitar falsos positivos (ex.: \bRESG\b não casa
  // "RESGUARDO"; \bCDB\b não casa palavras maiores).
  if (/\b(APLICA[CÇ][AÃ]O|RESG(ATE)?|AG\.?\s*EST\s+RESG|COFRINHO|FUNDO\s+(DI|RF|MULTI)|POUPAN[CÇ]A|CDB|TESOURO|LCI|LCA|PERSONDIF)\b/i.test(m))
    return 'MOVIMENTACAO_INTERNA';
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
  // Alimentação (delivery, padaria, restaurante, conveniência, mercado, fast food)
  if (/^PAY\s+IFD\b|^PAY\s+IFOOD|^ON\s+IFD\b/.test(m)) return 'ALIMENTACAO';
  if (/^PAY\s+RAPPI|^PAY\s+RPP|^PAY\s+(99FOOD|UBER\s*EATS|KEETA)/.test(m)) return 'ALIMENTACAO';
  if (/^PAY\s+(DONA|BAR|REST|PIZZA|HAMB|BURGER|CAFE|DOC|PADAR|ACOUG|BANCA|BOTEC|NONNA|FORNE|DAPAD|FBQ|NA\s+JA|JIM\s+C|DLKNE|CONVE|OXXO|MC\s*DO|MULTI|DLK|MANIA|TIC\s+T|RioRe|Marce|Inova|SAFRA)/.test(m))
    return 'ALIMENTACAO';
  // Transporte (combustível, posto, ride, estacionamento)
  if (/^PAY\s+UBR\b|^PAY\s+UBER/.test(m)) return 'TRANSPORTE';
  if (/^PAY\s+99\b/.test(m)) return 'TRANSPORTE';
  if (/^PAY\s+(POSTO|SHELL|IPIRANGA|PETROBR|ULTRA|BR\s|AutoP|ESTAPAR|ZUL\s|PARKING|ESTAC)/.test(m)) return 'TRANSPORTE';
  // Saúde (farmácia, drogaria, hospital, academia, clínica)
  if (/^PAY\s+(FARMA|DROGAS|DROGA|HOSP|CLINIC|RAIA|PACHECO|DROGASIL|ACADE|SMARTFIT|GYM|FLEURY|DASA)/.test(m)) return 'SAUDE';
  // Casa/Reforma (material, construção, decoração)
  if (/^PAY\s+(LEROY|TOK\s*STOK|TELHA|OBRAMAX|IKEA|HOME\s*CENTER|MADEIRA|CASAS\s+BAHIA)/.test(m)) return 'MORADIA';
  // Compras gerais (varejo, e-commerce, shopping)
  if (/^PAY\s+(HAVAN|DECAT|LOJAS|SHOPP|RENNER|RIACH|MAGALU|AMERIC|CASAS|AMAZON|MERC\s*LIVRE|SHEIN|SHOPEE|ZARA|HERING|NIKE|ADIDAS)/.test(m)) return 'COMPRAS_VAREJO';
  // Assinaturas/telco (operadora, streaming)
  if (/^PAY\s+(TIMO|VIVO|CLARO|TIM|OI|NETFLIX|SPOTIFY|DISNEY|HBO|GOOGLE|APPLE|MICROSOFT|YOUTUBE)/.test(m)) return 'ASSINATURAS';
  // Lazer/viagem
  if (/^PAY\s+(LATAM|GOL|AZUL|DECOLAR|BOOKING|AIRBNB|HOTEL|CINEMA|TEATRO|INGRESSO|ZIG|CINE)/.test(m)) return 'LAZER';
  // PIX vendor: marketplaces e contrapartes específicas
  if (/^PIX\s+QRS\s+(PIX\s+MARKETP|NU\s+PAGAMENT|MERCADO\s*PAGO|MERCADOPAG)/.test(m)) return 'TRANSFERENCIA';
  return null;
}

/**
 * Detecta despesa de utility/telco/imposto que deveria virar RecurringBill em
 * outro projeto (CASA ou CARRO). Retorna config ou null.
 */
type RecurrenceHint = {
  projectType: 'CASA' | 'CARRO';
  nome: string;
  categoria: string;        // LUZ | AGUA | GAS | INTERNET | TELEFONE | IPVA | OUTRO
  frequencia: 'MENSAL' | 'ANUAL';
};
function detectRecurrence(merchant: string): RecurrenceHint | null {
  const m = merchant.toUpperCase();
  // CASA — utilities
  if (/\bENEL\b|\bELETROPAULO\b|\bCEMIG\b|\bCOPEL\b|\bLIGHT\b|\bCOELBA\b|\bENERGISA\b/.test(m))
    return { projectType: 'CASA', nome: 'Energia elétrica', categoria: 'LUZ', frequencia: 'MENSAL' };
  if (/\bSABESP\b|\bCEDAE\b|\bCASAN\b|\bCAESB\b|\bSANEPAR\b/.test(m))
    return { projectType: 'CASA', nome: 'Água', categoria: 'AGUA', frequencia: 'MENSAL' };
  if (/\bCOMGAS\b|\bCEG\b|\bGAS\s+NATURAL\b/.test(m))
    return { projectType: 'CASA', nome: 'Gás', categoria: 'GAS', frequencia: 'MENSAL' };
  if (/\bVIVO\b|\bCLARO\b|\bTIM\b|\bNET\s|NETFLIX|\bSKY\b|\bOI\s/.test(m))
    return { projectType: 'CASA', nome: 'Internet/Telefone', categoria: 'INTERNET', frequencia: 'MENSAL' };
  // CARRO
  if (/\bIPVA\b/.test(m))
    return { projectType: 'CARRO', nome: 'IPVA', categoria: 'IPVA', frequencia: 'ANUAL' };
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

  /** Lista todas as contas do tenant (todos os projetos). Útil para vínculos cross-project. */
  async listAccountsTenant(tenantId: string) {
    return this.prisma.bankAccount.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }],
      include: { project: { select: { id: true, name: true, type: true } } },
    });
  }

  async createAccount(tenantId: string, projectId: string, dto: CreateBankAccountDto) {
    await this.ensureProject(tenantId, projectId);
    const nickname = dto.nickname?.trim() || `${dto.institution} ****${dto.last4}`;
    const { openingBalanceDate, ...rest } = dto;
    return this.prisma.bankAccount.create({
      data: {
        ...rest,
        nickname,
        tenantId,
        projectId,
        ...(openingBalanceDate ? { openingBalanceDate: new Date(openingBalanceDate) } : {}),
      },
    });
  }

  async updateAccount(tenantId: string, projectId: string, id: string, dto: UpdateBankAccountDto) {
    await this.findAccount(tenantId, projectId, id);
    const { openingBalanceDate, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    if (dto.nickname != null) {
      const t = dto.nickname.trim();
      if (t) data.nickname = t;
      else delete data.nickname;
    }
    if (openingBalanceDate !== undefined) {
      data.openingBalanceDate = openingBalanceDate ? new Date(openingBalanceDate) : null;
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

    // Carrega despesas E recebimentos planejados em outros projetos
    const otherProjects = await this.prisma.project.findMany({
      where: { tenantId, id: { not: projectId }, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    const projectById = new Map(otherProjects.map((p) => [p.id, p]));
    const otherIds = otherProjects.map((p) => p.id);
    const [plannedExpenses, plannedReceipts] = otherIds.length > 0
      ? await Promise.all([
          this.prisma.expense.findMany({
            where: { tenantId, projectId: { in: otherIds }, status: 'PLANEJADO', linkedExpenseId: null, deletedAt: null },
            take: 1000,
            orderBy: { dataInicioParcela: 'desc' },
          }),
          this.prisma.receipt.findMany({
            where: { tenantId, projectId: { in: otherIds }, status: 'PREVISTO', linkedReceiptId: null, deletedAt: null },
            take: 1000,
            orderBy: { data: 'desc' },
          }),
        ])
      : [[], []];

    function findExpenseMatches(tx: { date: Date; amountCents: number }) {
      if (plannedExpenses.length === 0) return [];
      const minDate = new Date(tx.date); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(tx.date); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const txCents = Math.abs(tx.amountCents);
      const tolerance = Math.max(100, Math.round(txCents * 0.05));
      return plannedExpenses
        .filter((p) => {
          if (Math.abs(p.valorTotal - txCents) > tolerance) return false;
          const pDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          return pDate >= minDate && pDate <= maxDate;
        })
        .slice(0, 5)
        .map((p) => {
          const proj = projectById.get(p.projectId);
          return {
            kind: 'expense' as const,
            expenseId: p.id,
            projectId: p.projectId,
            projectName: proj?.name ?? '',
            projectType: proj?.type ?? '',
            titulo: p.titulo,
            valorCents: p.valorTotal,
            data: (p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt).toISOString().slice(0, 10),
            deltaCents: txCents - p.valorTotal,
          };
        });
    }

    function findReceiptMatches(tx: { date: Date; amountCents: number }) {
      if (plannedReceipts.length === 0) return [];
      const minDate = new Date(tx.date); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(tx.date); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const txCents = Math.abs(tx.amountCents);
      const tolerance = Math.max(100, Math.round(txCents * 0.05));
      return plannedReceipts
        .filter((r) => {
          if (Math.abs(r.valor - txCents) > tolerance) return false;
          const rDate = r.data;
          return rDate >= minDate && rDate <= maxDate;
        })
        .slice(0, 5)
        .map((r) => {
          const proj = projectById.get(r.projectId);
          return {
            kind: 'receipt' as const,
            receiptId: r.id,
            projectId: r.projectId,
            projectName: proj?.name ?? '',
            projectType: proj?.type ?? '',
            titulo: r.descricao,
            valorCents: r.valor,
            data: r.data.toISOString().slice(0, 10),
            deltaCents: txCents - r.valor,
          };
        });
    }

    const preview = await Promise.all(parsed.transactions.map(async (tx) => {
      let isCardPay = tx.amountCents > 0 && detectCardPayment(tx.merchant).isCardPayment;
      // Match async por valor para "Pagamento PIX" / "PgConta" sem texto explícito
      if (!isCardPay && tx.amountCents > 0 && looksLikeOutboundTransfer(tx.merchant)) {
        const matched = await this.findCardPaymentByAmount(tenantId, tx.amountCents, tx.date);
        if (matched) isCardPay = true;
      }
      const matches = tx.amountCents < 0
        ? findReceiptMatches(tx)         // crédito → match com Receipt PLANEJADO
        : findExpenseMatches(tx);        // débito → match com Expense PLANEJADO
      return {
        ...tx,
        date: tx.date.toISOString().slice(0, 10),
        duplicate: existing.has(tx.externalId),
        isCredit: tx.amountCents < 0,
        isCardPayment: isCardPay,
        suggestedCategory: tx.amountCents > 0
          ? (isCardPay
              ? 'PAGAMENTO_FATURA_CARTAO'
              : (fastClassify(tx.merchant) ?? PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS'))
          : (fastClassify(tx.merchant) === 'MOVIMENTACAO_INTERNA' ? 'MOVIMENTACAO_INTERNA' : 'RECEITA'),
        crossProjectMatches: matches,
      };
    }));

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
    decisions?: BankImportDecision[],
  ) {
    const account = await this.findAccount(tenantId, projectId, accountId);
    const buf = typeof fileContent === 'string' ? Buffer.from(fileContent, 'utf-8') : fileContent;
    const parsed = await parseBankStatementBuffer(buf, account.id, source, fileName, password);
    const periodLabel = periodLabelOverride ?? parsed.periodLabel ?? new Date().toISOString().slice(0, 7);

    const decisionByExt = new Map<string, BankImportDecision>();
    for (const d of decisions ?? []) {
      if (d?.externalId) decisionByExt.set(d.externalId, d);
    }

    const existingIds = await this.findExistingExternalIds(
      tenantId,
      projectId,
      parsed.transactions.map((t) => t.externalId),
    );

    const toInsert = parsed.transactions.filter((t) => {
      const d = decisionByExt.get(t.externalId);
      if (d?.action === 'skip') return false;
      if (existingIds.has(t.externalId)) return false;
      return true;
    });
    const userSkipped = (decisions ?? []).filter((d) => d?.action === 'skip' && !existingIds.has(d.externalId)).length;
    const duplicated = parsed.transactions.length - toInsert.length - userSkipped;

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
    let linked = 0;
    for (const tx of toInsert) {
      const d = decisionByExt.get(tx.externalId);
      const adjustedTx: NormalizedTx = {
        ...tx,
        merchant: d?.overrides?.titulo ?? tx.merchant,
        amountCents: d?.overrides?.valorCents ?? tx.amountCents,
      };
      try {
        const result = await this.createExpenseFromTransaction(
          tenantId,
          projectId,
          account,
          adjustedTx,
          importRecord.id,
          d?.overrides?.category,
        );
        if (result.inserted) inserted++;
        if (result.receiptInserted) receiptsInserted++;
        if (result.cardPayment) cardPayments++;

        // Link cross-project
        if (d?.action === 'link') {
          try {
            if (d.linkToExpenseId && result.expenseId) {
              await this.linkToExpense(tenantId, projectId, result.expenseId, d.linkToExpenseId);
              linked++;
            } else if (d.linkToReceiptId && result.receiptId) {
              await this.linkToReceipt(tenantId, projectId, result.receiptId, d.linkToReceiptId);
              linked++;
            }
          } catch (linkErr) {
            console.warn(`[bank-import] link failed for ${tx.externalId.slice(0, 8)}:`, (linkErr as Error).message);
          }
        }
      } catch (err) {
        skipped++;
        console.warn(`[bank-import] tx skipped (${tx.externalId.slice(0, 8)}):`, (err as Error).message);
      }
    }

    // ─── Reclassificação inteligente via AI (Gemini) ──────────
    // Para todas as Expenses tipo OUTROS criadas neste import, consulta o
    // classifier (cache DB + Gemini). Atualiza tipoDespesa + categoria do CashFlow.
    const aiReclassified = await this.reclassifyImportedExpenses(tenantId, projectId, importRecord.id);

    // ─── Propagação de recorrências p/ projetos CASA/CARRO ───
    // Utilities (Enel/Sabesp/Comgas/...) viram RecurringBill no projeto CASA do tenant.
    // IPVA vira RecurringBill no projeto CARRO.
    const recurrencesCreated = await this.propagateRecurrences(tenantId, importRecord.id);

    await this.prisma.bankStatementImport.update({
      where: { id: importRecord.id },
      data: {
        inserted,
        skipped: skipped + userSkipped,
        message: [
          receiptsInserted > 0 ? `${receiptsInserted} recebimento(s)` : null,
          cardPayments > 0 ? `${cardPayments} pagto(s) de cartão vinculado(s)` : null,
          linked > 0 ? `${linked} vinculada(s) a planejado` : null,
          aiReclassified > 0 ? `${aiReclassified} categoria(s) sugerida(s) por IA` : null,
          recurrencesCreated > 0 ? `${recurrencesCreated} recorrência(s) propagada(s)` : null,
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
      recurrencesCreated,
      skipped: skipped + userSkipped,
      linked,
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

  /**
   * Para cada Expense criada neste import cujo fornecedor casa com detectRecurrence,
   * faz upsert de RecurringBill no projeto CASA ou CARRO do tenant.
   * - Match por (projectId+categoria+nome). Atualiza ultimoPagamento/proximoVencimento/valor.
   * - Se não houver projeto CASA/CARRO, pula silenciosamente.
   */
  private async propagateRecurrences(tenantId: string, importId: string): Promise<number> {
    const expenses = await this.prisma.expense.findMany({
      where: { tenantId, importId, deletedAt: null },
      select: { id: true, fornecedor: true, valor: true, dataPagamento: true },
    });
    if (!expenses.length) return 0;

    // Acha projetos CASA/CARRO do tenant (1x cada — primeiro encontrado)
    const houseProj = await this.prisma.project.findFirst({
      where: { tenantId, type: 'CASA', deletedAt: null },
      select: { id: true },
    });
    const carProj = await this.prisma.project.findFirst({
      where: { tenantId, type: 'CARRO', deletedAt: null },
      select: { id: true },
    });

    let created = 0;
    for (const exp of expenses) {
      const hint = detectRecurrence(exp.fornecedor || '');
      if (!hint) continue;
      const targetProjectId =
        hint.projectType === 'CASA' ? houseProj?.id : carProj?.id;
      if (!targetProjectId) continue;

      const payDate = exp.dataPagamento ?? new Date();
      const dia = payDate.getDate();
      // Upsert por (projectId, categoria, nome) — match insensível a case
      const existing = await this.prisma.recurringBill.findFirst({
        where: {
          tenantId,
          projectId: targetProjectId,
          categoria: hint.categoria,
          deletedAt: null,
        },
      });
      const proxVenc = this.nextDueAfter(payDate, dia, hint.frequencia);
      if (existing) {
        await this.prisma.recurringBill.update({
          where: { id: existing.id },
          data: {
            valor: exp.valor,
            ultimoPagamento: payDate,
            proximoVencimento: proxVenc,
            diaVencimento: dia,
          },
        });
      } else {
        await this.prisma.recurringBill.create({
          data: {
            tenantId,
            projectId: targetProjectId,
            nome: hint.nome,
            valor: exp.valor,
            categoria: hint.categoria,
            frequencia: hint.frequencia,
            diaVencimento: dia,
            status: 'ATIVO',
            ultimoPagamento: payDate,
            proximoVencimento: proxVenc,
            observacoes: `Detectado automaticamente do extrato (${exp.fornecedor})`,
          },
        });
        created++;
      }
    }
    return created;
  }

  private nextDueAfter(from: Date, dia: number, freq: 'MENSAL' | 'ANUAL'): Date {
    const d = new Date(from);
    if (freq === 'ANUAL') {
      d.setFullYear(d.getFullYear() + 1);
    } else {
      d.setMonth(d.getMonth() + 1);
    }
    d.setDate(Math.min(dia, 28));
    return d;
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

    const paymentDate = source.dataPagamento ?? source.dataInicioParcela ?? source.createdAt;

    const result = await this.prisma.$transaction(async (tx) => {
      // Re-lê target dentro da transação para evitar race com link concorrente.
      const target = await tx.expense.findFirst({
        where: { id: targetExpenseId, tenantId, deletedAt: null },
      });
      if (!target) throw new NotFoundException('Despesa alvo não encontrada');
      if (target.status === 'PAGO') {
        throw new BadRequestException('Despesa alvo já está paga — desvincule antes de re-linkar');
      }
      if (target.projectId === projectId) {
        throw new BadRequestException('Alvo deve estar em outro projeto');
      }

      await tx.expense.update({
        where: { id: target.id },
        data: {
          status: 'PAGO',
          dataPagamento: target.dataPagamento ?? target.dataInicioParcela ?? paymentDate,
        },
      });
      await tx.cashFlowEntry.updateMany({
        where: {
          tenantId,
          expenseId: target.id,
          status: { in: ['PLANEJADO', 'PREVISTO'] },
          deletedAt: null,
        },
        data: { status: 'PAGO' },
      });
      await tx.expense.update({
        where: { id: source.id },
        data: { linkedExpenseId: target.id },
      });

      return { targetId: target.id };
    });

    return { ok: true, sourceId: source.id, targetId: result.targetId, paymentDate };
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

  /**
   * Sugere vínculos para recebimentos importados (no PESSOAL) a recebimentos
   * planejados em outros projetos (REFORMA/CASA/CARRO).
   * Critério: mesmo tenant, valor ≈ (±5%), data ±10 dias, status PREVISTO.
   */
  async suggestReceiptLinks(tenantId: string, projectId: string, accountId: string) {
    const account = await this.findAccount(tenantId, projectId, accountId);

    const bankReceipts = await this.prisma.receipt.findMany({
      where: {
        tenantId,
        projectId,
        bankLast4: account.last4,
        linkedReceiptId: null,
        deletedAt: null,
      },
      orderBy: { data: 'desc' },
      take: 200,
    });

    if (bankReceipts.length === 0) return [];

    const otherProjects = await this.prisma.project.findMany({
      where: { tenantId, id: { not: projectId }, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    if (otherProjects.length === 0) {
      return bankReceipts.map((r) => ({ receipt: serializeReceipt(r), suggestions: [] }));
    }

    const otherIds = otherProjects.map((p) => p.id);
    const planned = await this.prisma.receipt.findMany({
      where: {
        tenantId,
        projectId: { in: otherIds },
        status: 'PREVISTO',
        deletedAt: null,
      },
      take: 500,
      orderBy: { data: 'desc' },
    });
    const projectById = new Map(otherProjects.map((p) => [p.id, p]));

    return bankReceipts.map((r) => {
      const minDate = new Date(r.data); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(r.data); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const tolerance = Math.max(100, Math.round(r.valor * 0.05));

      const matches = planned
        .filter((p) => {
          if (Math.abs(p.valor - r.valor) > tolerance) return false;
          return p.data >= minDate && p.data <= maxDate;
        })
        .slice(0, 5)
        .map((p) => ({
          receiptId: p.id,
          projectId: p.projectId,
          projectName: projectById.get(p.projectId)?.name ?? '',
          projectType: projectById.get(p.projectId)?.type ?? '',
          tipo: p.tipo,
          descricao: p.descricao,
          valor: p.valor,
          data: p.data.toISOString(),
          deltaCents: r.valor - p.valor,
        }));

      return { receipt: serializeReceipt(r), suggestions: matches };
    });
  }

  /**
   * Vincula um recebimento importado (do extrato, no PESSOAL) a um recebimento
   * planejado em outro projeto (PREVISTO em REFORMA/CASA/CARRO).
   *
   * Efeitos:
   *  - Recebimento alvo vira EM_CAIXA (mantendo data original).
   *  - CashFlowEntries do alvo viram EM_CAIXA.
   *  - Recebimento fonte ganha linkedReceiptId apontando para o alvo.
   *  - Visões consolidadas filtram entries com receipt.linkedReceiptId
   *    para evitar dupla contagem.
   */
  async linkToReceipt(
    tenantId: string,
    projectId: string,
    bankReceiptId: string,
    targetReceiptId: string,
  ) {
    const source = await this.prisma.receipt.findFirst({
      where: { id: bankReceiptId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Recebimento importado não encontrado');
    if (!source.bankLast4) throw new BadRequestException('Recebimento não foi importado de conta bancária');

    const result = await this.prisma.$transaction(async (tx) => {
      const target = await tx.receipt.findFirst({
        where: { id: targetReceiptId, tenantId, deletedAt: null },
      });
      if (!target) throw new NotFoundException('Recebimento alvo não encontrado');
      if (target.status === 'EM_CAIXA') {
        throw new BadRequestException('Recebimento alvo já está EM_CAIXA — desvincule antes de re-linkar');
      }
      if (target.projectId === projectId) {
        throw new BadRequestException('Alvo deve estar em outro projeto');
      }

      await tx.receipt.update({
        where: { id: target.id },
        data: { status: 'EM_CAIXA' },
      });
      await tx.cashFlowEntry.updateMany({
        where: {
          tenantId,
          receiptId: target.id,
          status: { in: ['PLANEJADO', 'PREVISTO'] },
          deletedAt: null,
        },
        data: { status: 'EM_CAIXA' },
      });
      await tx.receipt.update({
        where: { id: source.id },
        data: { linkedReceiptId: target.id },
      });

      return { targetId: target.id };
    });

    return { ok: true, sourceId: source.id, targetId: result.targetId };
  }

  /**
   * Desfaz o link entre um recebimento importado e o alvo.
   * NÃO reverte o status do alvo (pode ter sido marcado EM_CAIXA por outro motivo).
   */
  async unlinkReceipt(tenantId: string, projectId: string, bankReceiptId: string) {
    const source = await this.prisma.receipt.findFirst({
      where: { id: bankReceiptId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Recebimento não encontrado');
    if (!source.linkedReceiptId) return { ok: true, alreadyUnlinked: true };
    await this.prisma.receipt.update({
      where: { id: source.id },
      data: { linkedReceiptId: null },
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
    categoryOverride?: string,
  ): Promise<{ inserted: boolean; receiptInserted: boolean; cardPayment: boolean; expenseId?: string; receiptId?: string }> {
    if (tx.amountCents < 0) {
      const receiptAmount = -tx.amountCents;
      // Movimentação interna (resgate de aplicação/cofrinho etc.) entra como
      // crédito mas NÃO é receita real — vira Expense neutra (sem cashflow).
      // categoryOverride do usuário tem prioridade sobre o auto-detect.
      const isInternalMov = categoryOverride === 'MOVIMENTACAO_INTERNA'
        || (!categoryOverride && fastClassify(tx.merchant) === 'MOVIMENTACAO_INTERNA');
      if (isInternalMov) {
        // Resgate/movimentação interna entra como CRÉDITO → é ENTRADA (dinheiro
        // voltando da aplicação). Vira Receipt RESGATE (preserva a direção, em
        // linha com o consolidado financeiro). Antes virava Expense, o que
        // invertia o sinal do resgate.
        const receipt = await this.prisma.receipt.create({
          data: {
            tenantId,
            projectId,
            valor: receiptAmount,
            data: tx.date,
            tipo: 'RESGATE',
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
            categoria: 'RESGATE',
            subcategoria: account.nickname,
            formaPagamento: 'CONTA_CORRENTE',
            data: tx.date,
            status: 'EM_CAIXA',
          },
        });
        return { inserted: false, receiptInserted: true, cardPayment: false, receiptId: receipt.id };
      }
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
      return { inserted: false, receiptInserted: true, cardPayment: false, receiptId: receipt.id };
    }

    // ─── Detecção de pagamento de fatura de cartão ─────────────
    // (a) por texto explícito ("FATURA PAGA", "PAGTO CART CRED" etc.)
    const cardPaymentInfo = detectCardPayment(tx.merchant);
    let matchedCard: { id: string; last4: string; nickname: string } | null = null;
    let isCardPayment = cardPaymentInfo.isCardPayment;
    if (isCardPayment) {
      matchedCard = await this.findMatchingCreditCard(
        tenantId,
        tx.amountCents,
        tx.date,
        cardPaymentInfo.last4,
      );
    } else if (looksLikeOutboundTransfer(tx.merchant) && !categoryOverride) {
      // (b) match por valor — apenas transferências de saída sem texto explícito.
      // Ex.: "Pagamento PIX" da fatura 7777, "PgConta NU PAGAMENTOS SA" etc.
      // Critério estrito (±R$ 0,50, ±10 dias) para evitar falso positivo.
      matchedCard = await this.findCardPaymentByAmount(tenantId, tx.amountCents, tx.date);
      if (matchedCard) isCardPayment = true;
    }
    if (isCardPayment) {
      const e = await this.prisma.expense.create({
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
      return { inserted: false, receiptInserted: false, cardPayment: true, expenseId: e.id };
    }

    const expenseType = categoryOverride ||
      fastClassify(tx.merchant) ||
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

    // Tipos neutros (movimentação interna entre contas próprias) NÃO geram
    // cashflow — não afetam o saldo consolidado nem o total de despesas.
    if (expenseType === 'MOVIMENTACAO_INTERNA') {
      return { inserted: false, receiptInserted: false, cardPayment: false, expenseId: expense.id };
    }

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

    return { inserted: true, receiptInserted: false, cardPayment: false, expenseId: expense.id };
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

  /**
   * Match ESTRITO: usado quando o texto NÃO indica explicitamente pagamento
   * de cartão (ex.: "Pagamento PIX", "PgConta NU PAGAMENTOS"). Critérios mais
   * apertados para evitar falsos positivos:
   *   - tolerância de R$ 0,50 (não R$ 2 — assumimos valor exato)
   *   - janela de ±10 dias (pagto cai em D ou poucos dias após emissão da fatura)
   * Retorna null se não há match com alta confiança.
   */
  private async findCardPaymentByAmount(
    tenantId: string,
    amountCents: number,
    paymentDate: Date,
  ): Promise<{ id: string; last4: string; nickname: string } | null> {
    const tenDaysBefore = new Date(paymentDate);
    tenDaysBefore.setDate(tenDaysBefore.getDate() - 10);
    const tenDaysAfter = new Date(paymentDate);
    tenDaysAfter.setDate(tenDaysAfter.getDate() + 10);
    const tolerance = 50; // R$ 0,50
    const matches = await this.prisma.creditCardStatementImport.findMany({
      where: {
        tenantId,
        deletedAt: null,
        createdAt: { gte: tenDaysBefore, lte: tenDaysAfter },
        totalAmountCents: { gte: amountCents - tolerance, lte: amountCents + tolerance },
      },
      include: { card: { select: { id: true, last4: true, nickname: true } } },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    // Só aceitamos match ÚNICO — múltiplos = ambíguo (não classifica).
    if (matches.length === 1 && matches[0].card) return matches[0].card;
    return null;
  }
}

/**
 * Detecta se uma linha de extrato é pagamento de fatura de cartão.
 * Retorna also o hint de last4 se aparecer na descrição (ex: "PAGTO CART CRED 1234").
 */
export function detectCardPayment(merchant: string): { isCardPayment: boolean; last4: string | null } {
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
 * Heurística: a transação PARECE uma transferência de saída que poderia ser
 * pagamento de fatura mesmo sem texto explícito (PIX, TED, DOC, PgConta).
 * Não inclui PAY xxx (compras com cartão de débito) nem PIX QRS (consumo).
 *
 * Usada em conjunto com matching async por valor+data contra
 * CreditCardStatementImport para detectar "Pagamento PIX" da fatura.
 */
export function looksLikeOutboundTransfer(merchant: string): boolean {
  const m = merchant.toUpperCase().trim();
  if (/^PIX\s+(TRANSF|CARTAO)\b/.test(m)) return true;
  if (/^PAGAMENTO\s+PIX\b/.test(m)) return true;
  if (/^PGCONTA\b/.test(m)) return true;
  if (/^TED\b/.test(m)) return true;
  if (/^DOC\b/.test(m)) return true;
  return false;
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

function serializeReceipt(r: {
  id: string; valor: number; data: Date; tipo: string; status: string;
  descricao: string | null; bankLast4: string | null; linkedReceiptId: string | null;
}) {
  return {
    id: r.id,
    valor: r.valor,
    data: r.data.toISOString(),
    tipo: r.tipo,
    status: r.status,
    descricao: r.descricao,
    bankLast4: r.bankLast4,
    linkedReceiptId: r.linkedReceiptId,
  };
}
