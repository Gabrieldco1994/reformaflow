import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import { resolveAccessibleProjectScope } from '../common/access-rules';
import {
  ambiguousLast4Set,
  resolveUniqueLegacyMatch,
  AMBIGUOUS_ACCOUNT_MESSAGE,
  AMBIGUOUS_CARD_MESSAGE,
} from '../common/invoice-identity';
import {
  buildInstallments,
  buildMonthlyOverview,
  caixaMonthForCardPurchase,
  compareMonths,
  ExpenseTypeLabels,
  ExpenseType,
  invoiceMatchTolerance,
  ReceiptTypeLabels,
  isNeutralExpenseType,
  isConsumptionNeutralExpenseType,
  isNeutralReceiptType,
  isSinglePaymentForm,
  parsePaidParcelas,
  PaymentForm,
  todayLocalDateUtc,
  type MonthlyOverviewEntry,
} from '@reformaflow/domain';

const PROJECTION_STATUS = {
  CANONICAL: 'canonical',
  DEGRADED: 'degraded',
} as const;
const FINANCIAL_TIME_ZONE = 'America/Sao_Paulo';

/** Requester shape needed to resolve the PESSOAL Hub scope (mirrors `request.user`). */
export interface MonthlyOverviewRequester {
  role?: string;
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
  allowedModules?: string[];
}

/**
 * Requester das MUTAÇÕES de dinheiro (`payInvoice` / `undoInvoicePayment`).
 *
 * `id` é obrigatório porque ele é, ao mesmo tempo, a credencial (scope do anchor)
 * e a autoria auditada da despesa gerada (`Expense.createdByUserId`) — separar os
 * dois em argumentos distintos permitiria auditar um usuário e autorizar outro.
 * O tipo é REQUERIDO nas assinaturas: requester opcional é fail-open por
 * construção (quem esquece o argumento ganha acesso total silencioso).
 */
export interface MonthlyOverviewMutationRequester extends MonthlyOverviewRequester {
  id: string;
}

interface HubProject {
  id: string;
  type: string;
  name: string;
}

/** Anchor PESSOAL project + the concrete Hub scope resolved for it (see `resolveHub`). */
interface PessoalHub {
  pessoal: HubProject;
  allProjects: HubProject[];
  hubProjectIds: string[];
}

interface CarteiraExpenseRow {
  id: string;
  linkedExpenseId: string | null;
  titulo: string | null;
  fornecedor: string | null;
  tipoDespesa: string;
  formaPagamento: string;
  quantidadeParcela: number | null;
  valorTotal: number;
  dataPagamento: Date | null;
  dataInicioParcela: Date | null;
  dataCompra: Date | null;
  status: string;
  cardLast4: string | null;
  bankLast4: string | null;
  createdAt: Date;
  paidParcelas: string | null;
  installmentDateOverrides: string | null;
  settledByExpenseId: string | null;
}

interface CarteiraReceiptRow {
  valor: number;
  status: string;
  data: Date;
  bankLast4: string | null;
}

interface CarteiraOccurrence {
  expense: CarteiraExpenseRow;
  data: Date;
  valor: number;
  status: string;
  realizado: boolean;
  explicitlyPaid: boolean;
  parcelaIndex: number | null;
}

// ── Action derivation for enriched entries (U4, issue #453) ────────
// Mirrors the action logic in MovimentacaoRow.tsx (L214-250).
// Espelhos (linkedExpenseId) NEVER get mutation actions.
// Emitting an actionId does NOT authorize the mutation — each endpoint
// reauthorizes independently.
const INVOICE_TIPO = 'PAGAMENTO_FATURA_CARTAO';

interface ActionEntry {
  tipo: string;
  status: string;
  id: string;
  expenseId: string | null;
  receiptId: string | null;
  expense: {
    linkedExpenseId: string | null;
    cardLast4: string | null;
    bankLast4: string | null;
    tipoDespesa: string;
  } | null;
}

function deriveEntryActions(
  e: ActionEntry,
  espelho: boolean,
): Array<{ actionId: string }> {
  if (espelho) return [];

  const isDespesa = e.tipo === 'DESPESA';
  const isRecebimento = e.tipo === 'RECEBIMENTO';
  const isInvoice = isDespesa && e.expense?.tipoDespesa === INVOICE_TIPO;
  const realizado = isDespesa
    ? e.status === 'PAGO'
    : e.status === 'EM_CAIXA';
  const hasCard = !!e.expense?.cardLast4;

  const actions: Array<{ actionId: string }> = [];

  // edit — any non-espelho entry with an id
  if (isDespesa || (isRecebimento && !!e.id)) {
    actions.push({ actionId: 'edit' });
  }

  // ratear / vincular — despesa não-fatura, não-espelho (cross-link candidates)
  if (isDespesa && !isInvoice) {
    actions.push({ actionId: 'ratear' });
    actions.push({ actionId: 'vincular' });
  }

  // ajustar-fatura — invoice with known card
  if (isInvoice && hasCard) {
    actions.push({ actionId: 'ajustar-fatura' });
  }

  // quitar-parcela (resíduo) — unpaid invoice with card
  if (isInvoice && hasCard && !realizado) {
    actions.push({ actionId: 'quitar-parcela' });
  }

  // desfazer-pagamento — paid invoice
  if (isInvoice && realizado) {
    actions.push({ actionId: 'desfazer-pagamento' });
  }

  // excluir — same guard as edit
  if (isDespesa || (isRecebimento && !!e.id)) {
    actions.push({ actionId: 'excluir' });
  }

  return actions;
}

@Injectable()
export class MonthlyOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cardSettlement: CardInvoiceSettlementService,
  ) {}

  /**
   * Resolves the PESSOAL Hub scope ONCE per request/entry-point:
   *  1. 404 — the anchor project doesn't exist in this tenant (absent/deleted/cross-tenant).
   *  2. 403 — the anchor exists but sits outside the requester's authorized scope.
   *  3. 400 — the requester IS authorized for the anchor, but it isn't PESSOAL.
   *
   * `requester` omitted ⇒ full-access/legacy behavior (existing callers — e.g.
   * `tenant-financial`'s per-project delegation and any test that predates the
   * requester plumbing — keep working unchanged; #447 fingerprints must hold).
   *
   * The returned `hubProjectIds` is the Hub's cross-project fan-out: the
   * anchor PESSOAL plus every AUTHORIZED non-PESSOAL project — NEVER another
   * PESSOAL project, even for a full-access/no-requester caller (each PESSOAL
   * is its own independent wallet; merging two would double-count/leak).
   */
  private async resolveScope(
    tenantId: string,
    requester?: MonthlyOverviewRequester,
  ): Promise<string[] | null> {
    if (!requester) return null;
    return resolveAccessibleProjectScope(
      this.prisma,
      tenantId,
      requester.role,
      requester.allowedProjects,
      requester.allowedProjectTypes,
      requester.allowedModules ?? [],
    );
  }

  private buildCarteiraSnapshot(
    expenses: CarteiraExpenseRow[],
    receipts: CarteiraReceiptRow[],
    today: Date,
  ): { localCarteiraOccurrences: CarteiraOccurrence[]; carteiraHoje: number } {
    const localCarteiraOccurrences = expenses
      .filter(
        (expense) =>
          !expense.cardLast4 &&
          !expense.bankLast4 &&
          !isNeutralExpenseType(expense.tipoDespesa),
      )
      .flatMap((expense) => this.localExpenseOccurrences(expense, purchaseDate(expense)))
      .filter(({ expense }) => expense.status === 'PAGO' || !expense.settledByExpenseId);

    const carteiraHoje =
      sumBy(
        localCarteiraOccurrences.filter((occurrence) => countsInCarteiraToday(occurrence, today)),
        ({ valor }) => -valor,
      ) +
      sumBy(
        receipts.filter(
          (receipt) =>
            !receipt.bankLast4 && receipt.status === 'EM_CAIXA' && receipt.data <= today,
        ),
        (receipt) => receipt.valor,
      );

    return { localCarteiraOccurrences, carteiraHoje };
  }

  private localExpenseOccurrences(
    expense: CarteiraExpenseRow,
    singlePaymentDate: Date,
  ): CarteiraOccurrence[] {
    if (isSinglePaymentForm(expense.formaPagamento)) {
      const realizado = expense.status === 'PAGO';
      return [
        {
          expense,
          data: singlePaymentDate,
          valor: expense.valorTotal,
          status: realizado ? 'PAGO' : expense.status,
          realizado,
          explicitlyPaid: realizado && !hasDeclaredDate(expense),
          parcelaIndex: null,
        },
      ];
    }

    const installments = buildInstallments({
      formaPagamento: expense.formaPagamento,
      quantidadeParcela: expense.quantidadeParcela,
      valorTotal: expense.valorTotal,
      dataInicioParcela: expense.dataInicioParcela ?? expense.dataPagamento ?? singlePaymentDate,
      dataPagamento: expense.dataPagamento,
      installmentDateOverrides: expense.installmentDateOverrides,
    });
    const paidParcelas = new Set(parsePaidParcelas(expense.paidParcelas, installments.length));
    return installments.map((installment, index) => {
      const realizado = expense.status === 'PAGO' || paidParcelas.has(index);
      return {
        expense,
        data: installment.data,
        valor: installment.valor,
        status: realizado ? 'PAGO' : 'PLANEJADO',
        realizado,
        explicitlyPaid: paidParcelas.has(index),
        parcelaIndex: index as number | null,
      };
    });
  }

  /**
   * Anchor-only validation (404/403/400) for reads that never fan out
   * cross-project (card-invoices-yearly, neutros, origin-items-yearly): a
   * single `findFirst`, no tenant-wide project scan needed.
   */
  private async resolveAnchor(
    tenantId: string,
    pessoalProjectId: string,
    requester?: MonthlyOverviewRequester,
    precomputedScope?: string[] | null,
  ): Promise<HubProject> {
    const pessoal = await this.prisma.project.findFirst({
      where: { id: pessoalProjectId, tenantId, deletedAt: null },
      select: { id: true, type: true, name: true },
    });
    if (!pessoal) throw new NotFoundException('Projeto não encontrado');

    const scope =
      precomputedScope !== undefined ? precomputedScope : await this.resolveScope(tenantId, requester);
    if (scope !== null && !scope.includes(pessoal.id)) {
      throw new ForbiddenException('Sem permissão para acessar este projeto');
    }
    if (pessoal.type !== 'PESSOAL') {
      throw new BadRequestException(
        'Visão consolidada disponível apenas para projetos do tipo PESSOAL',
      );
    }
    return pessoal;
  }

  /** Full Hub resolution (anchor + cross-project fan-out) for reads that aggregate other projects. */
  private async resolveHub(
    tenantId: string,
    pessoalProjectId: string,
    requester?: MonthlyOverviewRequester,
  ): Promise<PessoalHub> {
    const scope = await this.resolveScope(tenantId, requester);
    const pessoal = await this.resolveAnchor(tenantId, pessoalProjectId, requester, scope);

    const allProjects = await this.prisma.project.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, type: true, name: true },
    });
    const hubProjectIds = allProjects
      .filter((p) => p.id === pessoal.id || p.type !== 'PESSOAL')
      .filter((p) => scope === null || scope.includes(p.id))
      .map((p) => p.id);

    return { pessoal, allProjects, hubProjectIds };
  }

  async getOverview(
    tenantId: string,
    pessoalProjectId: string,
    month?: string,
    requester?: MonthlyOverviewRequester,
  ) {
    const hub = await this.resolveHub(tenantId, pessoalProjectId, requester);

    // Hub scope (anchor PESSOAL + authorized non-PESSOAL — never another
    // PESSOAL, see `resolveHub`), NOT every project in the tenant.
    const projects = hub.allProjects.filter((p) => hub.hubProjectIds.includes(p.id));
    const projectIds = hub.hubProjectIds;
    const projectTypeById = new Map(projects.map((p) => [p.id, p.type] as const));
    const projectNameById = new Map(projects.map((p) => [p.id, p.name] as const));

    // Cash flow entries de todos os projetos (soft-deleted excluídos, e entries de
    // despesas/receipts soft-deleted também excluídos para consistência).
    // Entries de alocação de orçamento (budgetAllocationId) são transferências
    // internas entre projetos do mesmo tenant: o recebimento original já é contado
    // na origem, então o espelho na reforma contaria em dobro no consolidado.
    //
    // ATENÇÃO (vínculo cross-project / espelhos): NÃO excluímos mais espelhos
    // (expense.linkedExpenseId != null) no nível da query. O PESSOAL é o controlador
    // universal do caixa: o espelho representa dinheiro que saiu da conta pessoal e
    // PRECISA aparecer nos KPIs PESSOAL-only ("Em caixa"/"Projetado"). A deduplicação
    // (para o consolidado e para as linhas mês-a-mês) é feita adiante via flag
    // `isEspelho`, mantendo o alvo do projeto como canônico no consolidado.
    const entries = await this.prisma.cashFlowEntry.findMany({
      where: {
        tenantId,
        projectId: { in: projectIds },
        deletedAt: null,
        budgetAllocationId: null,
        OR: [{ expenseId: null }, { expense: { deletedAt: null } }],
        AND: [
          {
            OR: [{ receiptId: null }, { receipt: { deletedAt: null, linkedReceiptId: null } }],
          },
        ],
      },
      include: {
        expense: {
          select: {
            linkedExpenseId: true,
            cardLast4: true,
            bankLast4: true,
            tipoDespesa: true,
            titulo: true,
            fornecedor: true,
          },
        },
        receipt: {
          select: {
            tipo: true,
            bankLast4: true,
          },
        },
      },
      orderBy: [{ data: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    // Espelho = despesa PESSOAL vinculada a uma despesa de outro projeto.
    const isEspelho = (e: (typeof entries)[number]) => !!e.expense?.linkedExpenseId;

    // Adapta para o helper do domain (acrescenta projectOrigin e label de categoria).
    // Linhas mês-a-mês são consolidadas → excluem espelhos (o alvo do projeto é o canônico),
    // mantendo os totais idênticos ao comportamento anterior.
    const adapted: MonthlyOverviewEntry[] = entries
      .filter((e) => !isEspelho(e))
      .map((e) => ({
        tipo: e.tipo,
        valor: e.valor,
        status: e.status,
        data: e.data,
        categoria:
          e.categoria
            ? ExpenseTypeLabels[e.categoria as keyof typeof ExpenseTypeLabels] ?? e.categoria
            : null,
        projectOrigin: projectTypeById.get(e.projectId) ?? 'OUTROS',
      }));

    const rows = buildMonthlyOverview(adapted, { topCategorias: 6 });

    const today = todayLocalDateUtc(FINANCIAL_TIME_ZONE);
    const currentKey = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
    const comparison = compareMonths(rows, currentKey);

    // Entries enriquecidas com origem (project name + type) para a tabela / cockpit.
    // `isEspelho` permite que o cockpit conte o espelho no PESSOAL-only e o deduplique
    // no consolidado (ver derive.ts).
    const enrich = (e: (typeof entries)[number]) => ({
      id: e.id,
      data: e.data,
      tipo: e.tipo,
      status: e.status,
      valor: e.valor,
      categoria: e.categoria
        ? ExpenseTypeLabels[e.categoria as keyof typeof ExpenseTypeLabels] ?? e.categoria
        : null,
      categoriaCodigo: e.categoria ?? null,
      // Enum cru do tipo de despesa (join Expense) — sinal CONFIÁVEL de neutro,
      // ao contrário de `categoriaCodigo` (gravado ora label ora enum). Espelha a
      // regra da account-view (service:372) para o cockpit.
      tipoDespesaCodigo: e.expense?.tipoDespesa ?? null,
      isNeutral: isNeutralExpenseType(e.expense?.tipoDespesa),
      // Neutro DE CONSUMO (não é consumo/renda, mas é caixa real): inclui aporte
      // (INVESTIMENTOS) na despesa e resgate (RESGATE) no recebimento. Sinal separado
      // de `isNeutral` (settlement) — o cockpit usa este para tirar do consumo/resultado
      // SEM tirar do eixo de caixa (§10). Ver derive.ts / neutral.ts.
      isNeutralConsumo:
        e.tipo === 'RECEBIMENTO'
          ? isNeutralReceiptType(e.receipt?.tipo)
          : isConsumptionNeutralExpenseType(e.expense?.tipoDespesa),
      subcategoria: e.subcategoria,
      titulo: e.expense?.titulo ?? null,
      fornecedor: e.expense?.fornecedor ?? null,
      parcela: e.parcela,
      formaPagamento: e.formaPagamento,
      projectId: e.projectId,
      projectName: projectNameById.get(e.projectId) ?? '',
      projectType: projectTypeById.get(e.projectId) ?? 'OUTROS',
      cardLast4: e.expense?.cardLast4 ?? null,
      bankLast4: e.expense?.bankLast4 ?? null,
      isEspelho: isEspelho(e),
      expenseId: e.expenseId ?? null,
      // ── V1 card fields (issue #452) ──────────────────────────────
      kind: (e.tipo === 'DESPESA' ? 'expense' : 'receipt') as 'expense' | 'receipt',
      origin: projectTypeById.get(e.projectId) ?? 'OUTROS',
      originProjectId: e.projectId,
      originProjectName: projectNameById.get(e.projectId) ?? '',
      purpose: e.categoria ?? '',
      purposeLabel: e.categoria
        ? ExpenseTypeLabels[e.categoria as keyof typeof ExpenseTypeLabels] ?? e.categoria
        : '',
      amountCents: e.valor,
      date: e.data instanceof Date ? e.data.toISOString() : String(e.data),
      title: e.expense?.titulo ?? null,
      supplier: e.expense?.fornecedor ?? null,
      installment: e.parcela ?? null,
      paymentForm: e.formaPagamento ?? null,
      relationship: (e.expense?.cardLast4 || e.expense?.bankLast4 || e.receipt?.bankLast4)
        ? {
            cardLast4: e.expense?.cardLast4 ?? null,
            bankLast4: e.expense?.bankLast4 ?? e.receipt?.bankLast4 ?? null,
          }
        : null,
      hasEvidence: false,
      // U4 (#453): actions passam a ser derivadas no servidor a partir do estado
      // da entry. O invariante da #452 permanece — quem MUTA reautoriza no
      // handler; este campo só declara o que é oferecível.
      actions: deriveEntryActions(e, isEspelho(e)),
    });

    // Todas as entries (todos os meses) para permitir navegação de mês no cockpit.
    const allEntries = entries.map(enrich);

    // Entries do mês corrente (mantido para compatibilidade).
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const currentMonthEntries = allEntries.filter(
      (e) => e.data >= monthStart && e.data < monthEnd,
    );

    // Lista de projetos contribuintes (para legenda do gráfico)
    const contributingProjects = projects
      .filter((p) => p.id !== pessoalProjectId)
      .map((p) => ({ id: p.id, name: p.name, type: p.type }));

    const caixaComCarteira = await this.getCaixaConta(tenantId, pessoalProjectId, today);

    // Projeção de caixa do MÊS CORRENTE (eixo de caixa, §10) — fonte única para o
    // card "Projeção fim do mês" do cockpit, para casar EXATAMENTE com a Visão Conta.
    // A projeção é conceito de CAIXA: usa fatura vencendo + débitos planejados (via
    // Expense/buildInstallments, que o cashFlowEntry das entries NÃO materializa) +
    // parcelas cross vencendo, não a competência das entries. Aditivo e resiliente:
    // se falhar, o frontend cai no cálculo por competência (comportamento anterior).
    const projectionMonth = month ? normalizeMonthKey(month) : currentKey;
    let projecao:
      | {
          mes: string;
          status: typeof PROJECTION_STATUS.CANONICAL;
          caixaHoje: number;
          entrouMes: number;
          saiuMes: number;
          faltaPagarMes: number;
          recebimentosPrevistosMes: number;
          sobraPrevista: number;
          carteiraHoje: number;
        }
      | { mes: string; status: typeof PROJECTION_STATUS.DEGRADED };
    try {
      const av = await this.computeAccountView(tenantId, hub, projectionMonth, today);
      projecao = {
        mes: projectionMonth,
        status: PROJECTION_STATUS.CANONICAL,
        caixaHoje: av.caixaHoje,
        entrouMes: av.entrouMes,
        saiuMes: av.saiuMes,
        faltaPagarMes: av.faltaPagarMes,
        recebimentosPrevistosMes: av.recebimentosPrevistosMes,
        sobraPrevista: av.sobraPrevista,
        carteiraHoje: av.carteiraHoje,
      };
    } catch {
      projecao = { mes: projectionMonth, status: PROJECTION_STATUS.DEGRADED };
    }

    // Cartões do tenant (closingDay/dueDay) para derivar o "mês de caixa" das
    // faturas no cockpit (eixo caixa). Aditivo: não altera meses/caixa existentes.
    const cardRows = await this.prisma.creditCard.findMany({
      where: { tenantId, projectId: { in: projectIds }, deletedAt: null },
      select: { last4: true, nickname: true, closingDay: true, dueDay: true },
    });
    const seenLast4 = new Set<string>();
    const cards = cardRows.filter((c) => {
      if (seenLast4.has(c.last4)) return false;
      seenLast4.add(c.last4);
      return true;
    });

    return {
      mesAtual: currentKey,
      meses: rows,
      comparativo: comparison,
      mesAtualEntries: currentMonthEntries,
      entries: allEntries,
      projetos: contributingProjects,
      caixa: caixaComCarteira,
      cards,
      projecao,
    };
  }

  async getAccountView(
    tenantId: string,
    projectId: string,
    month?: string,
    requester?: MonthlyOverviewRequester,
  ) {
    const hub = await this.resolveHub(tenantId, projectId, requester);
    const today = todayLocalDateUtc(FINANCIAL_TIME_ZONE);
    return this.computeAccountView(tenantId, hub, month, today);
  }

  /**
   * Scoped core for the Visão Conta — resolves the Hub ONCE at the caller
   * (`getAccountView`/`getAccountViewYearly`/`getDreOverview`) instead of
   * re-resolving membership on every one of the up to 12 monthly calls.
   */
  private async computeAccountView(
    tenantId: string,
    hub: PessoalHub,
    month: string | undefined,
    today: Date,
  ) {
    const projectId = hub.pessoal.id;

    const mesSelecionado = normalizeMonthKey(month);
    const [monthStart, monthEnd] = monthRange(mesSelecionado);
    const sixMonthKeys = lastMonthKeys(mesSelecionado, 6);
    const sixMonthSet = new Set(sixMonthKeys);

    const [accounts, allExpenses, receipts, entries, cards, settlements, rateioAllocations, invoiceAdjustments] =
      await Promise.all([
      this.prisma.bankAccount.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
          id: true,
          openingBalanceCents: true,
          openingBalanceDate: true,
          last4: true,
          nickname: true,
          institution: true,
        },
      }),
      this.prisma.expense.findMany({
        // Hub scope, NOT every tenant expense: cross-project ("foreign")
        // participants must be limited to the anchor PESSOAL plus authorized
        // non-PESSOAL projects — a second/hidden PESSOAL or an out-of-scope
        // project can never feed this project's foreign/rateio computations.
        where: { tenantId, projectId: { in: hub.hubProjectIds }, deletedAt: null },
        select: {
          id: true,
          projectId: true,
          tipoDespesa: true,
          titulo: true,
          fornecedor: true,
          valor: true,
          valorTotal: true,
          formaPagamento: true,
          dataPagamento: true,
          dataInicioParcela: true,
          dataCompra: true,
          quantidadeParcela: true,
          status: true,
          cardLast4: true,
          bankLast4: true,
          importId: true,
          createdAt: true,
          linkedExpenseId: true,
          settledByExpenseId: true,
          settlesInvoiceKey: true,
          paidParcelas: true,
          installmentDateOverrides: true,
          project: { select: { id: true, name: true, type: true } },
        },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
          id: true,
          valor: true,
          data: true,
          tipo: true,
          status: true,
          descricao: true,
          bankLast4: true,
          importId: true,
        },
      }),
      this.prisma.cashFlowEntry.findMany({
        where: {
          tenantId,
          projectId,
          deletedAt: null,
          AND: [
            {
              OR: [{ expenseId: null }, { expense: { deletedAt: null } }],
            },
            {
              OR: [{ receiptId: null }, { receipt: { deletedAt: null } }],
            },
          ],
        },
        include: {
          expense: {
            select: {
              id: true,
              tipoDespesa: true,
              titulo: true,
              fornecedor: true,
              cardLast4: true,
              bankLast4: true,
              linkedExpenseId: true,
            },
          },
          receipt: {
            select: {
              id: true,
              tipo: true,
              descricao: true,
              bankLast4: true,
            },
          },
        },
        orderBy: [{ data: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.creditCard.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
          id: true,
          nickname: true,
          last4: true,
          closingDay: true,
          dueDay: true,
          limitTotalCents: true,
          limitAvailableCents: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.crossProjectSettlement.findMany({
        // Fonte do settlement é sempre o PESSOAL âncora (o espelho que liquida
        // a fatura/movimentação) — nunca outro PESSOAL do mesmo tenant. Escopo
        // explícito na query (não só no filtro em memória via allExpensesById)
        // para que a leitura nunca carregue linhas de um PESSOAL irmão.
        where: { tenantId, source: { projectId } },
      }),
      this.prisma.rateioAllocation.findMany({
        // Idem: rateio SEMPRE distribui de uma compra-fonte no PESSOAL âncora.
        where: { tenantId, source: { projectId } },
        select: { sourceExpenseId: true, targetExpenseId: true },
      }),
      this.prisma.invoiceAdjustment.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
          id: true,
          cardLast4: true,
          dueMonth: true,
          amountCents: true,
          reason: true,
        },
      }),
    ]);

    // O PESSOAL é o controlador universal do caixa: carregamos as despesas de
    // TODOS os projetos do tenant e particionamos. As do PESSOAL alimentam o
    // caixa/saídas (conta-only, §10); as de outros projetos servem para (a)
    // rotular a origem dos espelhos e (b) somar o planejado cross-project que
    // ainda sairá da conta pessoal em "Ainda falta pagar".
    const expenses = allExpenses.filter((expense) => expense.projectId === projectId);
    const foreignExpenses = allExpenses.filter((expense) => expense.projectId !== projectId);
    const primaryAccount = this.pickPrimaryBankAccount(accounts);
    const importAccountById = await this.getImportAccountMap(
      tenantId,
      accounts.map((account) => account.id),
    );
    const resolveMovementAccountId = this.buildAccountResolver(
      accounts,
      importAccountById,
      primaryAccount?.id ?? null,
    );
    // Recebimento pertence a ESTA visão (agregado/conta primária) se:
    //  - tem conta e ela resolve para a primária, OU
    //  - NÃO tem conta (sem conta) → cai sempre na visão primária, espelhando o
    //    tratamento localCarteira das despesas (§14: sem isto o recebimento sumia
    //    da Visão Conta e do caixa). NÃO entra em computeCaixaConta/§10 (bank-only).
    const receiptInPrimaryView = (receipt: { bankLast4: string | null; importId?: string | null }) =>
      !receipt.bankLast4 ||
      resolveMovementAccountId({
        bankLast4: receipt.bankLast4,
        importId: receipt.importId ?? null,
      }) === (primaryAccount?.id ?? null);
    const foreignById = new Map(foreignExpenses.map((expense) => [expense.id, expense] as const));
    // Espelhos PESSOAL (expenses com linkedExpenseId) agrupados pelo alvo foreign que
    // liquidam. Usado para classificar a ORIGEM de pagamento de cada foreign: quitada
    // por cartão (fatura já cobre), por conta/banco (espelho bank cobre os pagamentos
    // já feitos, mas parcelas futuras ainda saem da conta), ou sem espelho (lump).
    const espelhosByForeignId = new Map<string, typeof expenses>();
    for (const espelho of expenses) {
      if (!espelho.linkedExpenseId) continue;
      const bucket = espelhosByForeignId.get(espelho.linkedExpenseId);
      if (bucket) bucket.push(espelho);
      else espelhosByForeignId.set(espelho.linkedExpenseId, [espelho]);
    }
    type ForeignOrigin =
      | { origem: 'none' }
      | { origem: 'card' }
      | { origem: 'bank'; bankLast4: string | null };
    const classifyForeignOrigin = (foreignId: string): ForeignOrigin => {
      const espelhos = espelhosByForeignId.get(foreignId) ?? [];
      if (espelhos.length === 0) return { origem: 'none' };
      // Espelho misto (card + bank): prevalece 'card' (segurança — a fatura cobre).
      if (espelhos.some((e) => !!e.cardLast4)) return { origem: 'card' };
      const bankEspelho = espelhos.find((e) => !!e.bankLast4);
      return { origem: 'bank', bankLast4: bankEspelho?.bankLast4 ?? null };
    };

    // Foreign TOTALMENTE coberto por cartão: a soma dos espelhos de cartão vinculados
    // cobre o valorTotal do foreign. Nesse caso é um parcelado de cartão do valor cheio
    // — cada parcela cai na fatura do seu mês (comprasCartao), então NENHUMA parcela do
    // foreign vira saída de conta, mesmo que só a 1ª tenha crossProjectSettlement.
    // (Distingue do débito avulso que quita UMA parcela de um foreign maior: aí o cartão
    // cobre só aquela parcela e as demais seguem pendentes → cai no caminho por-parcela.)
    // ponytail: usa igualdade de valor (espelho importado == planejado, casa exato nos
    // dados reais). Se o planejado divergir do valor real cobrado, ajustar p/ tolerância.
    const isFullyCardCovered = (foreignId: string, foreignValorTotal: number): boolean => {
      const espelhos = espelhosByForeignId.get(foreignId) ?? [];
      const cardSum = espelhos
        .filter((e) => !!e.cardLast4)
        .reduce((sum, e) => sum + (e.valorTotal ?? 0), 0);
      return cardSum > 0 && cardSum >= foreignValorTotal;
    };

    const projetoOrigemFor = (linkedExpenseId: string | null | undefined) => {
      if (!linkedExpenseId) return null;
      const target = foreignById.get(linkedExpenseId);
      if (!target?.project) return null;
      return { id: target.project.id, name: target.project.name, type: target.project.type };
    };

    // P3 — origem POR PARCELA. Cada crossProjectSettlement mapeia (foreign, parcela)
    // ao espelho que a quitou; a origem (cartão/banco) é derivada do espelho.
    // Espelhos soft-deletados (P1/P2/P6) já saíram de `allExpenses`, então uma
    // parcela cujo espelho sumiu não é indevidamente suprimida.
    const allExpensesById = new Map(allExpenses.map((expense) => [expense.id, expense] as const));

    // Rateio (distribuição de UMA compra-fonte PESSOAL entre N alvos de outros
    // projetos): a FONTE representa integralmente a saída de caixa (cartão → a fatura
    // cobre; banco → aparece em accountExpenseList com suas parcelas). Os alvos são
    // apenas a distribuição contábil no projeto de destino e NÃO devem virar saída de
    // conta no PESSOAL — senão dobra. Só o 1º alvo recebe o vínculo `linkedExpenseId`;
    // sem este conjunto, os demais alvos cairiam no ramo "sem espelho" (lump) e
    // inflariam a projeção. Suprimimos todos os alvos cuja fonte ainda existe.
    const rateioTargetIds = new Set<string>();
    // Fontes de rateio (mesmas RateioAllocation acima, sem nova query): o rateio
    // grava `linkedExpenseId` na fonte apontando pro 1º alvo (mesmo campo do
    // vínculo simples de conciliação). Uma fonte PESSOAL "Carteira" (sem
    // cardLast4/bankLast4) some da Visão Conta se esse linkedExpenseId cair no
    // filtro genérico de espelho — viola AGENTS.md #14 (sem conta = Carteira,
    // nunca pode sumir). `rateioSourceIds` marca essas fontes para o filtro de
    // `localCarteiraThisMonth` NÃO as excluir, preservando a supressão do alvo
    // (rateioTargetIds acima) e do vínculo simples PAGO (manualWalletMirror...).
    const rateioSourceIds = new Set<string>();
    for (const a of rateioAllocations) {
      if (!allExpensesById.has(a.sourceExpenseId)) continue; // fonte sumiu → não suprime
      rateioTargetIds.add(a.targetExpenseId);
      rateioSourceIds.add(a.sourceExpenseId);
    }

    type ParcelaOrigin =
      | { origem: 'card' }
      | { origem: 'bank'; bankLast4: string | null };
    const parcelaOriginByForeign = new Map<string, Map<number, ParcelaOrigin>>();
    const hasSettlements = new Set<string>();
    for (const s of settlements) {
      const mirror = allExpensesById.get(s.sourceExpenseId);
      if (!mirror) continue; // espelho inexistente/soft-deletado → não suprime a parcela
      hasSettlements.add(s.targetExpenseId);
      const byIndex = parcelaOriginByForeign.get(s.targetExpenseId) ?? new Map<number, ParcelaOrigin>();
      const origem: ParcelaOrigin = mirror.cardLast4
        ? { origem: 'card' }
        : { origem: 'bank', bankLast4: mirror.bankLast4 ?? null };
      byIndex.set(s.parcelaIndex, origem);
      parcelaOriginByForeign.set(s.targetExpenseId, byIndex);
    }

    const caixa = computeCaixaConta(
      primaryAccount ? [primaryAccount] : accounts,
      expenses.filter(
        (expense) =>
          !!expense.bankLast4 &&
          resolveMovementAccountId({
            bankLast4: expense.bankLast4,
            importId: expense.importId ?? null,
          }) === (primaryAccount?.id ?? null),
      ),
      receipts.filter(
        (receipt) =>
          !!receipt.bankLast4 &&
          resolveMovementAccountId({
            bankLast4: receipt.bankLast4,
            importId: receipt.importId ?? null,
          }) === (primaryAccount?.id ?? null),
      ),
      today,
    );

    const entrouMes = sumBy(
      receipts.filter(
        (receipt) =>
          receiptInPrimaryView(receipt) &&
          receipt.status === 'EM_CAIXA' &&
          receipt.data >= monthStart &&
          receipt.data < monthEnd,
      ),
      (receipt) => receipt.valor,
    );

    const recebimentosPrevistosMes = sumBy(
      receipts.filter(
        (receipt) =>
          receiptInPrimaryView(receipt) &&
          receipt.status === 'PREVISTO' &&
          receipt.data >= monthStart &&
          receipt.data < monthEnd,
      ),
      (receipt) => receipt.valor,
    );

    const carteiraPotential = foreignExpenses.filter((e) => {
      const pass =
        e.status === 'PAGO' &&
        !isNeutralExpenseType(e.tipoDespesa) &&
        !rateioTargetIds.has(e.id) &&
        (espelhosByForeignId.get(e.id) ?? []).length === 0;
      return pass;
    });
    const carteiraPaidThisMonth = carteiraPotential.filter((e) =>
      isInRange(purchaseDate(e), monthStart, monthEnd),
    );

    // Espelhos PESSOAL pagos em carteira são lançamentos de caixa reais; a origem
    // foreign não tem como representar sua data efetiva. Mantém o espelho na lista
    // e suprime as parcelas pagas do alvo no mesmo mês abaixo. Settlements de
    // outras parcelas do mesmo alvo não anulam esse lançamento de carteira.
    const manualWalletMirrorTargetsThisMonth = new Set(
      expenses
        .filter(
          (expense) =>
            !!expense.linkedExpenseId &&
            !expense.cardLast4 &&
            !expense.bankLast4 &&
            expense.status === 'PAGO' &&
            isInRange(purchaseDate(expense), monthStart, monthEnd),
        )
        .map((expense) => expense.linkedExpenseId as string),
    );

    // Despesas LOCAIS do próprio projeto sem cartão E sem conta (ex.: lançadas
    // por voz sem meio de pagamento informado) — a "Carteira". Regra de ouro 14:
    // nunca sumir com origin:'none' do consolidado. Sem cartão/conta elas saem
    // direto do caixa como dinheiro; espelha o tratamento das foreign carteira,
    // mas para o projeto atual. Espelho em carteira fica como a representação de
    // caixa, mesmo se outras parcelas do alvo tiverem settlement.
    const { localCarteiraOccurrences, carteiraHoje } = this.buildCarteiraSnapshot(
      expenses,
      receipts,
      today,
    );
    const localCarteiraThisMonth = localCarteiraOccurrences.filter(
      ({ expense, data }) =>
        (!expense.linkedExpenseId ||
          rateioSourceIds.has(expense.id) ||
          manualWalletMirrorTargetsThisMonth.has(expense.linkedExpenseId)) &&
        isInRange(data, monthStart, monthEnd),
    );

    const saiuMes = sumBy(
      expenses.filter(
        (expense) =>
          !!expense.bankLast4 &&
          resolveMovementAccountId({
            bankLast4: expense.bankLast4,
            importId: expense.importId ?? null,
          }) === (primaryAccount?.id ?? null) &&
          expense.status === 'PAGO' &&
          isInRange(accountExpenseDate(expense), monthStart, monthEnd),
      ),
      (expense) => expense.valorTotal,
    ) +
    sumBy(carteiraPaidThisMonth, (expense) => expense.valorTotal);

    const cardByLast4 = new Map(cards.map((card) => [card.last4, card] as const));
    /**
     * B1b (#448): finais com MAIS DE UM cartão ativo neste projeto. `cardByLast4`
     * (e qualquer mapa por last4) colapsa duplicatas legadas num vencedor
     * arbitrário — servir esse palpite como identidade é o mesmo erro que o 409
     * de `payInvoice`/`undoInvoicePayment` recusa cometer. Aqui a consequência é
     * de CAPABILITY: uma fatura de final ambíguo não oferece CTA nem emite
     * `cardId`/`fingerprint`, porque nenhuma ação sobre ela é executável agora.
     */
    const ambiguousCardLast4 = ambiguousLast4Set(cards);
    const invoiceByMonthCard = buildCardInvoiceAggregates(entries, cards, invoiceAdjustments);

    const residualByInvoice = new Map<string, number>();
    for (const adj of invoiceAdjustments) {
      if (adj.reason !== 'QUITACAO_RESIDUO') continue;
      const key = `${adj.dueMonth}__${adj.cardLast4}`;
      residualByInvoice.set(key, (residualByInvoice.get(key) ?? 0) + Math.max(adj.amountCents, 0));
    }

    // Faturas quitadas por dois mecanismos (ver computePaidInvoiceKeys):
    //  - implícito: pagamentos via conta do PRÓPRIO cartão, somados por fatura por
    //    janela {mês do pagamento, mês+1} e com tolerância para quitação integral.
    //  - explícito: `settlesInvoiceKey` soma pagamentos direcionados à fatura alvo.
    const settlementInvoices = Array.from(invoiceByMonthCard.values()).map((invoice) => ({
      dueMonth: invoice.dueMonth,
      cardLast4: invoice.cardLast4,
      total: invoice.total,
    }));
    const invoicePayments = expenses.filter(
      (expense) =>
        expense.tipoDespesa === 'PAGAMENTO_FATURA_CARTAO' && !!expense.cardLast4,
    );
    const implicitPaymentsDetailed = invoicePayments
      .filter(
        (expense) =>
          !expense.settlesInvoiceKey && expense.status === 'PAGO' && !!expense.bankLast4,
      )
      .map((expense) => ({
        expenseId: expense.id,
        payMonth: monthKeyOf(accountExpenseDate(expense)),
        cardLast4: expense.cardLast4 as string,
        amount: expense.valorTotal,
      }));
    const implicitPayments = implicitPaymentsDetailed.map((payment) => ({
      payMonth: payment.payMonth,
      cardLast4: payment.cardLast4,
      amount: payment.amount,
    }));
    // Vínculo explícito (settlesInvoiceKey) não exige tipoDespesa === PAGAMENTO_FATURA_CARTAO:
    // esse tipo só é atribuído automaticamente pelo import; uma despesa criada manualmente
    // (ex.: MOVIMENTACAO_INTERNA + "Essa cobrança quita a fatura de outro cartão?") também
    // precisa contar aqui, senão o vínculo nunca abate a fatura alvo.
    const explicitSettlements = expenses
      .filter((expense) => !!expense.settlesInvoiceKey)
      .map((expense) => ({
        targetKey: settlesInvoiceKeyToInternal(expense.settlesInvoiceKey as string),
        amount: expense.valorTotal,
      }));
    const settlementTotals = computeInvoiceSettlementTotals(
      settlementInvoices,
      implicitPayments,
      explicitSettlements,
      residualByInvoice,
    );
    const paidInvoiceKeys = settlementTotals.paidInvoiceKeys;
    const implicitPaymentByInvoice = matchPaidInvoiceExpenseIds(
      settlementInvoices,
      implicitPaymentsDetailed,
    );

    for (const [invoiceKey, invoice] of invoiceByMonthCard) {
      const paidAmount = settlementTotals.paidAmountByInvoice.get(invoiceKey) ?? 0;
      const residualDeclared = residualByInvoice.get(invoiceKey) ?? 0;
      const required = Math.max(invoice.total - residualDeclared, 0);
      if (paidAmount >= required) {
        invoice.realized = Math.min(invoice.total, paidAmount + residualDeclared);
        invoice.pending = 0;
      } else {
        invoice.realized = Math.min(invoice.total, paidAmount);
        invoice.pending = Math.max(invoice.total - paidAmount, 0);
      }
      invoice.paidAmount = paidAmount;
      invoice.residualDeclared = residualDeclared;
    }

    const invoiceRows = Array.from(invoiceByMonthCard.values());
    const selectedInvoices = invoiceRows
      .filter((invoice) => invoice.dueMonth === mesSelecionado)
      .sort((a, b) => b.total - a.total);

    const accountExpenseList = expenses
      .filter((expense) => {
        if (!expense.bankLast4 || expense.cardLast4) return false;
        if (expense.settledByExpenseId) return false;
        if (
          resolveMovementAccountId({
            bankLast4: expense.bankLast4,
            importId: expense.importId ?? null,
          }) !== (primaryAccount?.id ?? null)
        ) {
          return false;
        }
        if (isNeutralExpenseType(expense.tipoDespesa)) return false;
        return true;
      })
      .flatMap((expense) => this.localExpenseOccurrences(expense, accountExpenseDate(expense)))
      .filter(({ data }) => isInRange(data, monthStart, monthEnd))
      .sort((a, b) => a.data.getTime() - b.data.getTime());

    const comprasCartao = entries
      .filter(
        (entry) =>
          entry.tipo === 'DESPESA' &&
          !!entry.expense?.cardLast4 &&
          !isNeutralExpenseType(entry.expense.tipoDespesa),
      )
      .map((entry) => {
        const cardLast4 = entry.expense!.cardLast4 as string;
        const card = cardByLast4.get(cardLast4) ?? null;
        const dueMonth = caixaMonthForCardPurchase(
          entry.data,
          card?.closingDay ?? null,
          card?.dueDay ?? null,
        );
        const invoicePaid = paidInvoiceKeys.has(`${dueMonth}__${cardLast4}`);
        return {
          id: entry.expense!.id as string | null,
          kind: 'saida' as const,
          descricao: expenseDisplayName(
            entry.expense!.tipoDespesa,
            entry.expense!.titulo,
            entry.expense!.fornecedor,
          ),
          data: entry.data.toISOString(),
          forma: 'cartao',
          valor: entry.valor,
          realizado: invoicePaid,
          status: invoicePaid ? 'PAGO' : 'PLANEJADO',
          cardLast4,
          bankLast4: null as string | null,
          tipoDespesa: entry.expense!.tipoDespesa,
          isInvoice: false,
          editavel: true,
          dueMonth,
          projetoOrigem: projetoOrigemFor(entry.expense!.linkedExpenseId),
        };
      })
      .filter((row) => row.dueMonth === mesSelecionado)
      .sort((a, b) => b.data.localeCompare(a.data));

    // Planejado/realizado de outros projetos que sai (ou já saiu) da conta pessoal
    // (o PESSOAL é o consolidador). Deduplicado contra planejados já liquidados
    // (settledByExpenseId) e contra a ORIGEM de pagamento do espelho pessoal
    // (classifyForeignOrigin):
    //  - card  → a fatura do cartão já cobre; não emite saída de conta (evita dobra).
    //  - bank à-vista → o espelho bank quitado já aparece em accountExpenseList.
    //  - bank/carteira parcelado/quinzenal → emite CADA parcela no mês do próprio
    //    vencimento, pendente se não paga, realizado se já paga via paidParcelas
    //    (mantém a linha visível mesmo paga — bug #306, dinheiro não pode sumir).
    //  - sem espelho → mantém o lump (valorTotal) na data de compra (comportamento legado).
    const foreignPendingItems: Array<any> = foreignExpenses
      .filter((expense) => {
        if (expense.status === 'PAGO') return false;
        if (expense.settledByExpenseId) return false;
        if (isNeutralExpenseType(expense.tipoDespesa)) return false;
        return true;
      })
      .flatMap((expense) => {
        // Alvo de rateio: a compra-fonte PESSOAL já cobre a saída (fatura/conta).
        // Não re-emite — evita dupla contagem na projeção.
        if (rateioTargetIds.has(expense.id)) return [];
        const origin = classifyForeignOrigin(expense.id);
        const projetoOrigem = expense.project
          ? { id: expense.project.id, name: expense.project.name, type: expense.project.type }
          : null;
        const descricao = expenseDisplayName(
          expense.tipoDespesa,
          expense.titulo,
          expense.fornecedor,
        );
        const forma = inferCashForm(
          `${expense.titulo ?? ''} ${expense.fornecedor ?? ''}`,
          expense.formaPagamento,
        );

        // Foreign TOTALMENTE coberto por cartão (parcelado de cartão do valor cheio):
        // a fatura já cobre TODAS as parcelas — cada uma cai na fatura do seu mês (via
        // comprasCartao do espelho). Nunca vira saída de conta, mesmo que só a 1ª parcela
        // tenha crossProjectSettlement. Suprime ANTES do caminho por-parcela: senão as
        // parcelas futuras não-quitadas vazariam para "falta pagar" enquanto a fatura já
        // as contém → dupla contagem no consolidado/runway (bug do cartão cross-project).
        if (isFullyCardCovered(expense.id, expense.valorTotal)) return [];

        // P3 — caminho POR PARCELA: o foreign tem ≥1 crossProjectSettlement.
        // Cada parcela quitada é suprimida (fatura do cartão / espelho bank já a
        // representam); as demais permanecem pendentes no próprio vencimento (I9),
        // carregando parcelaIndex + foreignExpenseId para o front abrir a quitação (P7).
        if (hasSettlements.has(expense.id)) {
          const parcelaOrigins =
            parcelaOriginByForeign.get(expense.id) ?? new Map<number, ParcelaOrigin>();
          const perParcela = buildInstallments({
            valorTotal: expense.valorTotal,
            formaPagamento: expense.formaPagamento,
            quantidadeParcela: expense.quantidadeParcela,
            dataInicioParcela: expense.dataInicioParcela,
            dataPagamento: expense.dataPagamento,
            installmentDateOverrides: expense.installmentDateOverrides,
          });
          let paidByOther: Set<number>;
          try {
            const parsed = JSON.parse(expense.paidParcelas ?? '[]');
            paidByOther = new Set(Array.isArray(parsed) ? (parsed as number[]) : []);
          } catch {
            paidByOther = new Set<number>();
          }
          return perParcela.flatMap((parcela, index) => {
            // Parcela quitada cross-project → coberta pela fatura/espelho, não re-emite.
            if (parcelaOrigins.has(index)) return [];
            if (!isInRange(parcela.data, monthStart, monthEnd)) return [];
            // Parcela já paga por outra via (paidParcelas), sem settlement cobrindo-a:
            // mantém a linha como REALIZADO em vez de descartar — senão o valor some
            // do consolidado sem nenhuma substituta (bug #306).
            const paidHere = paidByOther.has(index);
            // Espelho PESSOAL manual em carteira representa o caixa com sua data
            // real; não duplicar a parcela planejada do alvo no mesmo mês (#309).
            if (paidHere && manualWalletMirrorTargetsThisMonth.has(expense.id)) return [];
            // Determine origem based on the foreign expense origin
            const itemOrigem = origin.origem === 'bank'
              ? { tipo: 'conta' as const, bankLast4: origin.bankLast4 }
              : { tipo: 'carteira' as const };
            return [
              {
                id: `${expense.id}#${index}` as string | null,
                kind: 'saida' as const,
                descricao,
                data: parcela.data.toISOString(),
                forma,
                valor: parcela.valor,
                realizado: paidHere,
                status: paidHere ? 'PAGO' : expense.status,
                cardLast4: null as string | null,
                bankLast4: null as string | null,
                tipoDespesa: expense.tipoDespesa,
                isInvoice: false,
                // Editável (edit/excluir) mesmo sendo foreign: o usuário pode corrigir/
                // apagar o planejamento cross-project direto da Conta pessoal (mesma
                // ação que faria abrindo o projeto de origem). O toggle RÁPIDO de status
                // continua bloqueado no front (canToggle) — só "Quitar" (que gera o
                // espelho de caixa) ou a edição do projeto de origem podem marcar PAGO,
                // nunca esta ação sozinha (evitaria dinheiro fantasma no consolidado).
                editavel: true,
                dueMonth: null as string | null,
                projetoOrigem,
                parcelaIndex: index as number | null,
                foreignExpenseId: expense.id as string | null,
                origem: itemOrigem,
              } as any,
            ];
          });
        }

        // Foreign de cartão parcialmente coberto e SEM settlement (link manual legado):
        // não caiu no supressor de cobertura total nem no caminho por-parcela. A fatura
        // cobre a parte no cartão → não re-emite como saída de conta (comportamento legado).
        if (origin.origem === 'card') return [];

        // Foreign sem espelho (sem cartão/conta/quitação): não há origem de
        // pagamento definida ainda. À vista → lump legado na data de compra.
        // Parcelada/quinzenal → espalha as parcelas no vencimento de cada uma
        // (respeita o parcelamento que o usuário configurou na despesa do projeto).
        if (origin.origem === 'none') {
          if (isSinglePaymentForm(expense.formaPagamento)) {
            if (!isInRange(purchaseDate(expense), monthStart, monthEnd)) return [];
            return [
              {
                id: expense.id as string | null,
                kind: 'saida' as const,
                descricao,
                data: purchaseDate(expense).toISOString(),
                forma,
                valor: expense.valorTotal,
                realizado: false,
                status: expense.status,
                cardLast4: null as string | null,
                bankLast4: null as string | null,
                tipoDespesa: expense.tipoDespesa,
                isInvoice: false,
                // Editável (edit/excluir) mesmo sendo foreign — ver comentário no
                // caminho por-parcela acima. Sem toggle rápido de status aqui também.
                editavel: true,
                dueMonth: null as string | null,
                projetoOrigem,
                parcelaIndex: null as number | null,
                foreignExpenseId: expense.id as string | null,
                origem: { tipo: 'carteira' as const },
              } as any,
            ];
          }

          const parcelasNone = buildInstallments({
            valorTotal: expense.valorTotal,
            formaPagamento: expense.formaPagamento,
            quantidadeParcela: expense.quantidadeParcela,
            dataInicioParcela: expense.dataInicioParcela,
            dataPagamento: expense.dataPagamento,
            installmentDateOverrides: expense.installmentDateOverrides,
          });
          let paidNone: Set<number>;
          try {
            const parsed = JSON.parse(expense.paidParcelas ?? '[]');
            paidNone = new Set(Array.isArray(parsed) ? (parsed as number[]) : []);
          } catch {
            paidNone = new Set<number>();
          }
          return parcelasNone.flatMap((parcela, index) => {
            if (!isInRange(parcela.data, monthStart, monthEnd)) return [];
            // Parcela já paga (paidParcelas): mantém a linha como REALIZADO em vez de
            // descartar — senão o valor some do consolidado sem substituta (bug #306).
            const paidHere = paidNone.has(index);
            if (paidHere && manualWalletMirrorTargetsThisMonth.has(expense.id)) return [];
            return [
              {
                id: `${expense.id}#${index}` as string | null,
                kind: 'saida' as const,
                descricao,
                data: parcela.data.toISOString(),
                forma,
                valor: parcela.valor,
                realizado: paidHere,
                status: paidHere ? 'PAGO' : expense.status,
                cardLast4: null as string | null,
                bankLast4: null as string | null,
                tipoDespesa: expense.tipoDespesa,
                isInvoice: false,
                // Editável (edit/excluir) mesmo sendo foreign — ver comentário no
                // caminho por-parcela acima. Sem toggle rápido de status aqui também.
                editavel: true,
                dueMonth: null as string | null,
                projetoOrigem,
                parcelaIndex: index as number | null,
                foreignExpenseId: expense.id as string | null,
                origem: { tipo: 'carteira' as const },
              },
            ];
          });
        }

        // origin.origem === 'bank': à-vista já coberta pelo espelho bank em
        // accountExpenseList → não re-emite.
        if (isSinglePaymentForm(expense.formaPagamento)) return [];

        // Parcelado/quinzenal bank-paid: emite cada parcela no mês do próprio
        // vencimento — pendente se ainda não paga, realizado se já paga via
        // paidParcelas (mantém a linha em vez de descartar; bug #306).
        const parcelas = buildInstallments({
          valorTotal: expense.valorTotal,
          formaPagamento: expense.formaPagamento,
          quantidadeParcela: expense.quantidadeParcela,
          dataInicioParcela: expense.dataInicioParcela,
          dataPagamento: expense.dataPagamento,
          installmentDateOverrides: expense.installmentDateOverrides,
        });
        let paidSet: Set<number>;
        try {
          const parsed = JSON.parse(expense.paidParcelas ?? '[]');
          paidSet = new Set(Array.isArray(parsed) ? (parsed as number[]) : []);
        } catch {
          paidSet = new Set<number>();
        }

        return parcelas.flatMap((parcela, index) => {
          if (!isInRange(parcela.data, monthStart, monthEnd)) return [];
          // Only reach here when origin.origem === 'bank'
          if (origin.origem !== 'bank') return [];
          const paidHere = paidSet.has(index);
          if (paidHere && manualWalletMirrorTargetsThisMonth.has(expense.id)) return [];
          return [
            {
              id: `${expense.id}#${index}` as string | null,
              kind: 'saida' as const,
              descricao,
              data: parcela.data.toISOString(),
              forma,
              valor: parcela.valor,
              realizado: paidHere,
              status: paidHere ? 'PAGO' : expense.status,
              cardLast4: null as string | null,
              bankLast4: origin.bankLast4,
              tipoDespesa: expense.tipoDespesa,
              isInvoice: false,
              editavel: false,
              dueMonth: null as string | null,
              projetoOrigem,
              parcelaIndex: index as number | null,
              foreignExpenseId: expense.id as string | null,
              origem: { tipo: 'conta' as const, bankLast4: origin.bankLast4 },
            } as any,
          ];
        });
      });

    const faltaPagarMes =
      sumBy(selectedInvoices, (invoice) => invoice.pending) +
      sumBy(
        accountExpenseList.filter((occurrence) => !occurrence.realizado),
        (occurrence) => occurrence.valor,
      ) +
      sumBy(foreignPendingItems, (item) => item.valor);

    const saidas: Array<any> = [
      ...selectedInvoices.map((invoice) => {
        // B1a (#448): mesma fatura, mesmos campos aditivos do `cartoes[]`
        // (cardId/fingerprint/actions) — aqui é a ENTRADA que a Visão Conta
        // realmente usa como "linha de fatura" (`saidas[].isInvoice`).
        // B1b (#448): com final ambíguo, `cardByLast4` devolveria um id
        // ADIVINHADO entre as duplicatas. Emiti-lo seria pior que o silêncio
        // antigo: um web novo mandaria esse id exato e passaria por cima do 409,
        // agindo justamente sobre o cartão que o servidor chutou.
        const ambiguousCard = ambiguousCardLast4.has(invoice.cardLast4);
        const cardIdForInvoice = ambiguousCard
          ? null
          : cardByLast4.get(invoice.cardLast4)?.id ?? null;
        const hasUndoableImplicitPayment =
          (implicitPaymentByInvoice.get(`${invoice.dueMonth}__${invoice.cardLast4}`) ?? null) != null;
        const invoiceActions: Array<'pay' | 'undo'> = [];
        if (!ambiguousCard) {
          if (invoice.pending > 0) invoiceActions.push('pay');
          if (hasUndoableImplicitPayment) invoiceActions.push('undo');
        }
        return {
          id: implicitPaymentByInvoice.get(`${invoice.dueMonth}__${invoice.cardLast4}`) ?? null,
          kind: 'saida' as const,
          descricao: `Fatura ${invoice.nickname}`,
          data: dueDateIso(mesSelecionado, invoice.dueDay),
          forma: 'cartao',
          valor: invoice.total,
          realizado: invoice.pending === 0,
          status: invoice.pending === 0 ? 'PAGO' : invoice.paidAmount > 0 ? 'PARCIAL' : 'PLANEJADO',
          cardId: cardIdForInvoice,
          cardLast4: invoice.cardLast4,
          bankLast4: null as string | null,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          isInvoice: true,
          editavel: hasUndoableImplicitPayment,
          actions: invoiceActions,
          fingerprint: cardIdForInvoice ? `${cardIdForInvoice}:${invoice.dueMonth}` : null,
          dueMonth: invoice.dueMonth,
          invoicePaidAmount: invoice.paidAmount,
          invoiceResidualDeclared: invoice.residualDeclared,
          invoiceHasManualIntervention: invoice.hasManualIntervention,
          invoiceAdjustmentAmount: invoice.adjustmentAmount,
          projetoOrigem: null as { id: string; name: string; type: string } | null,
          parcelaIndex: null as number | null,
          foreignExpenseId: null as string | null,
        };
      }),
      ...accountExpenseList.map(
        ({ expense, data, valor, status, realizado, parcelaIndex }) => ({
          id: expense.id as string | null,
          kind: 'saida' as const,
          descricao: expenseDisplayName(expense.tipoDespesa, expense.titulo, expense.fornecedor),
          data: data.toISOString(),
          forma: inferCashForm(
            `${expense.titulo ?? ''} ${expense.fornecedor ?? ''}`,
            expense.formaPagamento,
          ),
          valor,
          realizado,
          status,
          cardLast4: null as string | null,
          bankLast4: expense.bankLast4,
          tipoDespesa: expense.tipoDespesa,
          isInvoice: false,
          editavel: true,
          dueMonth: null as string | null,
          projetoOrigem: projetoOrigemFor(expense.linkedExpenseId),
          parcelaIndex,
          foreignExpenseId: null as string | null,
        }),
      ),
      // PAGO carteira items (foreign expenses without espelhos, paid in the current month)
      ...carteiraPaidThisMonth.map((expense) => {
        const descricao = expenseDisplayName(
          expense.tipoDespesa,
          expense.titulo,
          expense.fornecedor,
        );
        const forma = inferCashForm(
          `${expense.titulo ?? ''} ${expense.fornecedor ?? ''}`,
          expense.formaPagamento,
        );
        return {
          id: expense.id as string | null,
          kind: 'saida' as const,
          descricao,
          data: purchaseDate(expense).toISOString(),
          forma,
          valor: expense.valorTotal,
          realizado: true,
          status: expense.status,
          cardLast4: null as string | null,
          bankLast4: null as string | null,
          tipoDespesa: expense.tipoDespesa,
          isInvoice: false,
          // Editável (edit/excluir) mesmo sendo foreign — mesma regra das outras
          // linhas "carteira" acima. O toggle rápido de status continua bloqueado
          // no front (canToggle) mesmo já estando PAGO aqui.
          editavel: true,
          dueMonth: null as string | null,
          projetoOrigem: expense.project
            ? { id: expense.project.id, name: expense.project.name, type: expense.project.type }
            : null,
          parcelaIndex: null as number | null,
          foreignExpenseId: expense.id as string | null,
          origem: { tipo: 'carteira' as const },
        } as any;
      }),
      // Carteira LOCAL (despesa do próprio projeto sem cartão nem conta).
      // Cada parcela é emitida no seu mês efetivo.
      ...localCarteiraThisMonth.map(
        ({ expense, data, valor, status, realizado, parcelaIndex }) => ({
          id: expense.id as string | null,
          kind: 'saida' as const,
          descricao: expenseDisplayName(expense.tipoDespesa, expense.titulo, expense.fornecedor),
          data: data.toISOString(),
          forma: inferCashForm(
            `${expense.titulo ?? ''} ${expense.fornecedor ?? ''}`,
            expense.formaPagamento,
          ),
          valor,
          realizado,
          status,
          cardLast4: null as string | null,
          bankLast4: null as string | null,
          tipoDespesa: expense.tipoDespesa,
          isInvoice: false,
          editavel: true,
          dueMonth: null as string | null,
          projetoOrigem: null as { id: string; name: string; type: string } | null,
          parcelaIndex,
          foreignExpenseId: null as string | null,
          origem: { tipo: 'carteira' as const },
        }),
      ),
      ...foreignPendingItems,
    ].sort((a, b) => b.data.localeCompare(a.data));

    // Recalculate saiuMes and faltaPagarMes to include all saidas (including carteira)
    // This ensures carteira items are properly counted in the totals
    const recalculatedSaiuMes = sumBy(
      saidas.filter((s: any) => s.kind === 'saida' && s.realizado),
      (s: any) => s.valor,
    );
    const recalculatedFaltaPagarMes = sumBy(
      saidas.filter((s: any) => s.kind === 'saida' && !s.realizado),
      (s: any) => s.valor,
    );

    const entradas = receipts
      .filter(
        (receipt) =>
          receiptInPrimaryView(receipt) &&
          (receipt.status === 'EM_CAIXA' || receipt.status === 'PREVISTO') &&
          receipt.data >= monthStart &&
          receipt.data < monthEnd,
      )
      .sort((a, b) => b.data.getTime() - a.data.getTime())
      .map((receipt) => ({
        id: receipt.id as string | null,
        kind: 'entrada' as const,
        descricao: receipt.descricao?.trim() || receiptTypeLabel(receipt.tipo),
        // Descrição crua (sem fallback do label) — usada só para prefixar o modal
        // de edição, para não persistir o rótulo como se fosse texto do usuário.
        descricaoRaw: receipt.descricao?.trim() || null,
        data: receipt.data.toISOString(),
        tipo: receiptTypeKey(receipt.tipo),
        valor: receipt.valor,
        bankLast4: receipt.bankLast4,
        origem: receipt.bankLast4
          ? { tipo: 'conta' as const, bankLast4: receipt.bankLast4 }
          : { tipo: 'carteira' as const },
        status: receipt.status,
      }));

    const devoCartaoTotal = sumBy(
      invoiceRows.filter((invoice) => invoice.pending > 0),
      (invoice) => invoice.pending,
    );

    const ticketByMonth = new Map<string, { total: number; count: number }>();
    for (const monthKey of sixMonthKeys) {
      ticketByMonth.set(monthKey, { total: 0, count: 0 });
    }

    for (const expense of expenses) {
      if (isNeutralExpenseType(expense.tipoDespesa)) continue;
      const key = monthKeyOf(purchaseDate(expense));
      if (!sixMonthSet.has(key)) continue;
      const acc = ticketByMonth.get(key);
      if (!acc) continue;
      acc.total += expense.valorTotal;
      acc.count += 1;
    }

    const serie6m = sixMonthKeys.map((key, index) => {
      const current = ticketByMonth.get(key) ?? { total: 0, count: 0 };
      const previousKey = index > 0 ? sixMonthKeys[index - 1] : null;
      const previous = previousKey ? ticketByMonth.get(previousKey) ?? { total: 0, count: 0 } : null;
      const currentAvg = current.count > 0 ? Math.round(current.total / current.count) : 0;
      const previousAvg =
        previous && previous.count > 0 ? Math.round(previous.total / previous.count) : 0;
      return {
        mes: key,
        valor: currentAvg,
        deltaPct:
          !previous || previousAvg === 0 ? null : roundPct(((currentAvg - previousAvg) / previousAvg) * 100),
      };
    });

    const ticketAtual = ticketByMonth.get(mesSelecionado) ?? { total: 0, count: 0 };
    const ticketValor = ticketAtual.count > 0 ? Math.round(ticketAtual.total / ticketAtual.count) : 0;
    const media6mBase = serie6m.filter((item) => item.valor > 0);
    const media6m =
      media6mBase.length > 0
        ? Math.round(media6mBase.reduce((sum, item) => sum + item.valor, 0) / media6mBase.length)
        : 0;
    const deltaVsMediaPct = media6m > 0 ? roundPct(((ticketValor - media6m) / media6m) * 100) : null;

    const cartoes = cards.map((card) => {
      const openInvoiceMonth = mesSelecionado;
      const invoice =
        invoiceByMonthCard.get(`${openInvoiceMonth}__${card.last4}`) ??
        ({
          dueMonth: openInvoiceMonth,
          cardLast4: card.last4,
          nickname: card.nickname?.trim() || `Cartao ${card.last4}`,
          dueDay: card.dueDay ?? null,
          total: 0,
          pending: 0,
          realized: 0,
          paidAmount: 0,
          residualDeclared: 0,
          adjustmentAmount: 0,
          hasManualIntervention: false,
        } satisfies CardInvoiceAggregate);
      const canShowLimit =
        card.limitTotalCents != null && card.limitAvailableCents != null && card.limitTotalCents > 0;
      const limitTotal = canShowLimit ? card.limitTotalCents! : null;
      const limitAvailable = canShowLimit ? card.limitAvailableCents! : null;
      const limiteUsado = canShowLimit
        ? Math.max(limitTotal! - limitAvailable!, 0)
        : null;
      // B1a (#448): `actions` só lista verbos EXECUTÁVEIS agora — 'pay' quando
      // sobra saldo a pagar, 'undo' apenas quando existe EXATAMENTE UM
      // pagamento implícito casado com esta fatura (o mesmo casamento que
      // `undoInvoicePayment` exige para não reverter o pagamento errado —
      // ver `implicitPaymentByInvoice`/`assignImplicitPayments`). `fingerprint`
      // identifica a fatura por ID (cardId), nunca por last4/PAN.
      // B1b (#448): final ambíguo não expõe verbo NENHUM — a fatura é agregada
      // por last4, então as duplicatas mostram a MESMA fatura duas vezes e o
      // `payInvoice` legado responderia 409. `cardId` continua sendo o id REAL
      // desta linha (identidade própria, não um palpite entre duplicatas).
      const ambiguousCard = ambiguousCardLast4.has(card.last4);
      const invoiceKeyForCard = `${openInvoiceMonth}__${card.last4}`;
      const hasUndoableImplicitPayment =
        (implicitPaymentByInvoice.get(invoiceKeyForCard) ?? null) != null;
      const actions: Array<'pay' | 'undo'> = [];
      if (!ambiguousCard) {
        if (invoice.pending > 0) actions.push('pay');
        if (hasUndoableImplicitPayment) actions.push('undo');
      }
      return {
        cardId: card.id,
        nickname: card.nickname?.trim() || 'Cartao',
        last4: card.last4,
        faturaAtual: invoice.total,
        faturaPendente: invoice.pending,
        faturaPaga: invoice.paidAmount,
        residualDeclarado: invoice.residualDeclared,
        possuiIntervencaoManual: invoice.hasManualIntervention,
        ajusteManualTotal: invoice.adjustmentAmount,
        dueMonth: openInvoiceMonth,
        vencimento: dueDateIso(openInvoiceMonth, card.dueDay),
        status: invoice.pending === 0 ? 'paga' : invoice.paidAmount > 0 ? 'parcial' : 'a pagar',
        limiteUsadoPct:
          canShowLimit && limiteUsado != null
            ? Math.round((limiteUsado / limitTotal!) * 100)
            : null,
        limiteUsado,
        limiteTotal: limitTotal,
        actions,
        fingerprint: `${card.id}:${openInvoiceMonth}`,
      };
    });

    const contas = accounts
      .filter((account) => !!account.last4)
      .map((account) => ({
        accountId: account.id,
        last4: account.last4,
        nome: account.nickname?.trim() || account.institution || `Conta ${account.last4}`,
      }));

    return {
      mesSelecionado,
      caixaHoje: caixa.hoje,
      carteiraHoje,
      entrouMes,
      saiuMes: recalculatedSaiuMes,
      faltaPagarMes: recalculatedFaltaPagarMes,
      recebimentosPrevistosMes,
      // #519: a sobra prevista é dinheiro DISPONÍVEL de verdade — banco + carteira.
      // `carteiraHoje` (saldo pontual da carteira, já sinalizado: despesa −, dinheiro
      // em caixa +) e `caixa.hoje` (§10, bank-only) são partições disjuntas por
      // presença de `bankLast4`, então somam sem dupla contagem. Sem esta parcela,
      // uma despesa paga em carteira sumia da sobra e a tela mostrava mais dinheiro
      // do que existe (R$ 1.000 onde só havia R$ 945).
      sobraPrevista: caixa.hoje + carteiraHoje - recalculatedFaltaPagarMes + recebimentosPrevistosMes,
      devoCartaoTotal,
      cartoes,
      contas,
      saidas,
      comprasCartao,
      entradas,
      ticketMedio: {
        valor: ticketValor,
        nCompras: ticketAtual.count,
        totalCompras: ticketAtual.total,
        serie6m,
        media6m,
        deltaVsMediaPct,
      },
    };
  }

  async getAccountViewYearly(
    tenantId: string,
    projectId: string,
    year?: string | number,
    requester?: MonthlyOverviewRequester,
  ) {
    const hub = await this.resolveHub(tenantId, projectId, requester);
    const today = todayLocalDateUtc(FINANCIAL_TIME_ZONE);

    const targetYear = normalizeYear(year);
    const months = Array.from({ length: 12 }, (_, index) =>
      `${targetYear}-${String(index + 1).padStart(2, '0')}`,
    );

    // ponytail: 12 chamadas pesadas em paralelo — só serializar/limitar concorrência
    // se medição mostrar esgotamento do pool do SQLite; não otimizar às cegas.
    // Hub resolvido UMA vez acima (não 12x): reusa o mesmo escopo por mês.
    const accountViewsByMonth = await Promise.all(
      months.map((month) => this.computeAccountView(tenantId, hub, month, today)),
    );

    // Consolidar resultados: concatenar todos os itens e somar agregados
    const saidas = accountViewsByMonth.flatMap((av) => av.saidas);
    const comprasCartao = accountViewsByMonth.flatMap((av) => av.comprasCartao);
    const entradas = accountViewsByMonth.flatMap((av) => av.entradas);

    // `caixaHoje`/`carteiraHoje` são saldos PONTUAIS (computados sobre todo o
    // histórico, não filtrados por mês) — computeCaixaConta e o cálculo de
    // carteiraHoje ignoram `mesSelecionado`, então os 12 meses devolvem o MESMO
    // valor. Por isso pegamos de qualquer um dos 12 (aqui, o 1º) em vez de somar:
    // somar inflaria em 12x um número que já representa "hoje" inteiro.
    const firstAccountView = accountViewsByMonth[0]!;
    const contas = firstAccountView.contas; // estático (tenant), não varia por mês
    const caixaHoje = firstAccountView.caixaHoje;
    const carteiraHoje = firstAccountView.carteiraHoje;

    // `devoCartaoTotal` é da MESMA natureza pontual: em getAccountView ele soma
    // `invoiceRows` (TODAS as faturas do histórico com saldo pendente), que NÃO é
    // filtrado por `mesSelecionado` — só `selectedInvoices`/`comprasCartao` são.
    // Logo os 12 meses devolvem o mesmo saldo devedor e somar inflaria 12x.
    const devoCartaoTotal = firstAccountView.devoCartaoTotal;

    // Cartões: agregar os campos de fatura (mensais por natureza) ao longo do
    // ano em vez de zerá-los — a UI anual precisa saber quanto foi faturado,
    // pago e quanto ainda falta pagar no ano por cartão.
    const cartoes = firstAccountView.cartoes.map((card) => {
      const monthlyCards = accountViewsByMonth.map(
        (av) => av.cartoes.find((c) => c.last4 === card.last4)!,
      );
      const faturaAtual = sumBy(monthlyCards, (c) => c.faturaAtual);
      const faturaPendente = sumBy(monthlyCards, (c) => c.faturaPendente);
      const faturaPaga = sumBy(monthlyCards, (c) => c.faturaPaga);
      const residualDeclarado = sumBy(monthlyCards, (c) => c.residualDeclarado);
      const ajusteManualTotal = sumBy(monthlyCards, (c) => c.ajusteManualTotal);
      return {
        ...card,
        faturaAtual,
        faturaPendente,
        faturaPaga,
        residualDeclarado,
        possuiIntervencaoManual: monthlyCards.some((c) => c.possuiIntervencaoManual),
        ajusteManualTotal,
        // status do ano: "a pagar" se sobra alguma fatura pendente no ano,
        // "parcial" se já pagou algo mas ainda falta, "paga" se quitou tudo.
        status: (faturaPendente === 0
          ? 'paga'
          : faturaPaga > 0
            ? 'parcial'
            : 'a pagar') as 'paga' | 'parcial' | 'a pagar',
      };
    });

    // Somar agregados do ano inteiro (fluxos genuínos: cada `getAccountView(mes)`
    // já filtra por aquele mês, então somar os 12 é a soma do ano)
    const entrouMes = accountViewsByMonth.reduce((sum, av) => sum + av.entrouMes, 0);
    const saiuMes = accountViewsByMonth.reduce((sum, av) => sum + av.saiuMes, 0);
    const faltaPagarMes = accountViewsByMonth.reduce((sum, av) => sum + av.faltaPagarMes, 0);
    const recebimentosPrevistosMes = accountViewsByMonth.reduce((sum, av) => sum + av.recebimentosPrevistosMes, 0);

    // Ticket médio: DERIVADO dos 12 resultados mensais, nunca recomputado de outra
    // base. Recomputar a partir de `saidas` (que exclui `comprasCartao`) daria um
    // número diferente do que a tela mensal mostra para o mesmo mês — a mesma
    // métrica divergindo entre duas telas. Cada `getAccountView(mes)` já devolve
    // `nCompras`/`totalCompras` daquele mês, então a série é cópia e o ano é soma.
    const ticketSerie = months.map((mes, index) => ({
      mes,
      valor: accountViewsByMonth[index]!.ticketMedio.valor,
      deltaPct: null,
    }));
    const totalTickets = sumBy(accountViewsByMonth, (av) => av.ticketMedio.totalCompras);
    const countTickets = sumBy(accountViewsByMonth, (av) => av.ticketMedio.nCompras);
    const ticketAnual = countTickets > 0 ? Math.round(totalTickets / countTickets) : 0;

    return {
      mesSelecionado: `${targetYear}-01`,
      caixaHoje, // saldo pontual de hoje — idêntico em qualquer um dos 12 meses
      carteiraHoje, // idem: saldo pontual, não fluxo
      entrouMes, // = soma do ano
      saiuMes, // = soma do ano
      faltaPagarMes, // = soma do ano
      recebimentosPrevistosMes, // = soma do ano
      // Projeção: saldo de hoje contra tudo que falta pagar/receber no ano inteiro.
      // #519: `caixaHoje` e `carteiraHoje` são AMBOS saldos pontuais de hoje (pegos
      // uma vez de `firstAccountView`, idênticos nos 12 meses — somar não infla 12×,
      // é a MESMA operação do mensal). Sem a carteira, uma saída paga em carteira
      // sumia da sobra anual exatamente como sumia da mensal.
      sobraPrevista: caixaHoje + carteiraHoje - faltaPagarMes + recebimentosPrevistosMes,
      devoCartaoTotal, // saldo pontual de faturas em aberto — idem, não é fluxo mensal
      cartoes,
      contas,
      saidas: saidas.sort((a, b) => b.data.localeCompare(a.data)),
      comprasCartao: comprasCartao.sort((a, b) => b.data.localeCompare(a.data)),
      entradas: entradas.sort((a, b) => b.data.localeCompare(a.data)),
      ticketMedio: {
        valor: ticketAnual,
        nCompras: countTickets,
        totalCompras: totalTickets,
        // Série de 12 meses (não 6) — nome próprio para não confundir com o
        // `ticketMedio.serie6m` do getAccountView mensal.
        serie12m: ticketSerie,
        mediaAnual: ticketAnual,
        deltaVsMediaPct: null,
      },
    };
  }

  async getDreOverview(
    tenantId: string,
    projectId: string,
    params?: { month?: string; year?: string | number },
    requester?: MonthlyOverviewRequester,
  ) {
    const hub = await this.resolveHub(tenantId, projectId, requester);
    const today = todayLocalDateUtc(FINANCIAL_TIME_ZONE);

    const mesSelecionado = normalizeMonthKey(params?.month);
    const anoSelecionado = normalizeYear(
      params?.year ?? parseInt(mesSelecionado.slice(0, 4), 10),
    );

    const projectIds = [projectId];

    const [entries, cards] = await Promise.all([
      this.prisma.cashFlowEntry.findMany({
        where: {
          tenantId,
          projectId: { in: projectIds },
          deletedAt: null,
          budgetAllocationId: null,
          OR: [{ expenseId: null }, { expense: { deletedAt: null } }],
          AND: [
            {
              OR: [{ receiptId: null }, { receipt: { deletedAt: null, linkedReceiptId: null } }],
            },
          ],
        },
        include: {
          expense: {
            select: {
              id: true,
              tipoDespesa: true,
              titulo: true,
              fornecedor: true,
              cardLast4: true,
              bankLast4: true,
              linkedExpenseId: true,
            },
          },
          receipt: {
            select: {
              id: true,
              tipo: true,
              descricao: true,
              bankLast4: true,
            },
          },
        },
        orderBy: [{ data: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.creditCard.findMany({
        where: { tenantId, projectId: { in: projectIds }, deletedAt: null },
        select: { last4: true, nickname: true, closingDay: true, dueDay: true },
      }),
    ]);
    const accountView = await this.computeAccountView(
      tenantId,
      hub,
      mesSelecionado,
      today,
    );

    const cardByLast4 = new Map<string, { nickname: string; closingDay: number | null; dueDay: number | null }>();
    for (const card of cards) {
      if (cardByLast4.has(card.last4)) continue;
      cardByLast4.set(card.last4, {
        nickname: card.nickname?.trim() || `Cartão ${card.last4}`,
        closingDay: card.closingDay ?? null,
        dueDay: card.dueDay ?? null,
      });
    }

    const normalized: DreLine[] = [];
    for (const entry of entries) {
      if (entry.expense?.linkedExpenseId) continue;

      const realized = entry.status === 'PAGO' || entry.status === 'EM_CAIXA';
      const monthCompetencia = monthKeyOf(entry.data);

      if (entry.tipo === 'RECEBIMENTO') {
        // Resgate (RESGATE) é retorno de principal, não renda: neutralizado simétrico
        // ao aporte (INVESTIMENTOS, que fica no bucket "Guardado"). Rendimentos
        // (JUROS_RENDA_FIXA, DIVIDENDOS, …) são ganho real → permanecem como receita.
        if (isNeutralReceiptType(entry.receipt?.tipo)) continue;
        const sourceLabel = receiptSourceLabel(entry.receipt?.tipo);
        normalized.push({
          kind: 'entrada',
          valor: entry.valor,
          mesCompetencia: monthCompetencia,
          mesConta: monthCompetencia,
          realizado: realized,
          label:
            entry.receipt?.descricao?.trim() ||
            receiptTypeLabel(entry.receipt?.tipo ?? 'OUTROS'),
          sourceLabel,
          sourceIcon: receiptSourceIcon(sourceLabel),
        });
        continue;
      }

      if (!entry.expense) continue;
      const tipoDespesa = entry.expense.tipoDespesa ?? 'OUTROS';
      if (isNeutralExpenseType(tipoDespesa)) continue;

      const meta = dreExpenseMeta(tipoDespesa);
      const card = entry.expense.cardLast4
        ? cardByLast4.get(entry.expense.cardLast4) ?? null
        : null;
      const mesConta = entry.expense.cardLast4
        ? caixaMonthForCardPurchase(
            entry.data,
            card?.closingDay ?? null,
            card?.dueDay ?? null,
          )
        : monthCompetencia;

      normalized.push({
        kind: 'saida',
        valor: entry.valor,
        mesCompetencia: monthCompetencia,
        mesConta,
        realizado: realized,
        label: expenseDisplayName(
          tipoDespesa,
          entry.expense.titulo,
          entry.expense.fornecedor,
        ),
        group: meta.group,
        icon: meta.icon,
        color: meta.color,
        isGuardado: meta.isGuardado,
        cardLast4: entry.expense.cardLast4,
      });
    }

    const entradasMes = groupSimpleLines(
      normalized.filter(
        (line) =>
          line.kind === 'entrada' &&
          line.realizado &&
          line.mesCompetencia === mesSelecionado,
      ),
      (line) => line.sourceLabel ?? 'Outros',
      (line) => ({ label: line.sourceLabel ?? 'Outros', icon: line.sourceIcon ?? 'wallet' }),
    );
    const totalEntrou = sumBy(entradasMes, (line) => line.valor);

    const saidasCompetenciaBrutas = normalized.filter(
      (line) =>
        line.kind === 'saida' &&
        line.realizado &&
        line.mesCompetencia === mesSelecionado,
    );
    const guardadoMes = groupSimpleLines(
      saidasCompetenciaBrutas.filter((line) => line.isGuardado),
      (line) => line.group ?? 'Guardado',
      (line) => ({ label: line.group ?? 'Guardado', icon: line.icon ?? 'piggy-bank' }),
    );
    const totalGuardadoMes = sumBy(guardadoMes, (line) => line.valor);

    const saidasCompetencia = groupDreGroups(
      saidasCompetenciaBrutas.filter((line) => !line.isGuardado),
    );
    const totalSaiuCompetencia = sumBy(
      saidasCompetencia.flatMap((group) => group.items),
      (line) => line.valor,
    );

    const entradasConta = groupLabelValues(
      // Eixo conta do DRE é REALIZADO: recebimento PREVISTO entra na lista da
      // Visão Conta (getAccountView.entradas) mas NÃO pode somar aqui como realizado.
      accountView.entradas
        .filter((entrada) => entrada.status === 'EM_CAIXA')
        .map((entrada) => ({
          label: entrada.descricao,
          valor: entrada.valor,
        })),
    );
    const faturasItems = groupLabelValues(
      accountView.saidas
        .filter((saida) => saida.isInvoice)
        .map((saida) => ({
          label: saida.descricao,
          valor: saida.valor,
        })),
    );
    const debitosItems = groupLabelValues(
      accountView.saidas
        .filter((saida) => !saida.isInvoice)
        .map((saida) => ({
          label: saida.projetoOrigem
            ? `${saida.descricao} · ${saida.projetoOrigem.name}`
            : saida.descricao,
          valor: saida.valor,
        })),
    );
    const saidasCaixa = [
      ...(faturasItems.length > 0
        ? [{ group: 'Faturas de cartão', icon: 'credit-card', color: '#D85A30', items: faturasItems }]
        : []),
      ...(debitosItems.length > 0
        ? [{ group: 'Débitos automáticos', icon: 'building-bank', color: '#BA7517', items: debitosItems }]
        : []),
    ];
    const contaCorrenteResumo = {
      caixaHoje: accountView.caixaHoje,
      entrouMes: accountView.entrouMes,
      saiuMes: accountView.saiuMes,
      faltaPagarMes: accountView.faltaPagarMes,
      recebimentosPrevistosMes: accountView.recebimentosPrevistosMes,
      sobraPrevista: accountView.sobraPrevista,
      despesaTotal: accountView.saiuMes + accountView.faltaPagarMes,
    };

    // Resultado = receita − despesa de consumo. "Guardado" (investimento/aporte) é
    // transferência, não gasto: fica como memo informativo e NÃO reduz o resultado
    // (decisão de produto — coerente com o cockpit e com "investir não é despesa").
    const resultadoMes = totalEntrou - totalSaiuCompetencia;
    const resultadoMesAnterior = dreMonthResult(
      normalized,
      monthKeyPlus(mesSelecionado, -1),
    );
    const deltaVsMesAnterior =
      resultadoMesAnterior === 0
        ? 0
        : roundPct(((resultadoMes - resultadoMesAnterior) / Math.abs(resultadoMesAnterior)) * 100);

    const months = Array.from({ length: 12 }, (_, i) => `${anoSelecionado}-${String(i + 1).padStart(2, '0')}`);
    const realizedUntil =
      anoSelecionado < today.getUTCFullYear()
        ? 12
        : anoSelecionado === today.getUTCFullYear()
          ? today.getUTCMonth() + 1
          : 0;

    const monthRows = months.map((mes, index) => {
      const receitas = sumBy(
        normalized.filter(
          (line) =>
            line.kind === 'entrada' &&
            line.realizado &&
            line.mesCompetencia === mes,
        ),
        (line) => line.valor,
      );
      const despesas = sumBy(
        normalized.filter(
          (line) =>
            line.kind === 'saida' &&
            line.realizado &&
            !line.isGuardado &&
            line.mesCompetencia === mes,
        ),
        (line) => line.valor,
      );
      const guardado = sumBy(
        normalized.filter(
          (line) =>
            line.kind === 'saida' &&
            line.realizado &&
            line.isGuardado &&
            line.mesCompetencia === mes,
        ),
        (line) => line.valor,
      );
      const margem = receitas - despesas;
      const receitasPlanejadas = sumBy(
        normalized.filter(
          (line) =>
            line.kind === 'entrada' &&
            !line.realizado &&
            line.mesCompetencia === mes,
        ),
        (line) => line.valor,
      );
      const despesasPlanejadas = sumBy(
        normalized.filter(
          (line) =>
            line.kind === 'saida' &&
            !line.realizado &&
            !line.isGuardado &&
            line.mesCompetencia === mes,
        ),
        (line) => line.valor,
      );
      return {
        mes,
        monthIndex: index + 1,
        receitas,
        receitasPlanejadas,
        despesas,
        despesasPlanejadas,
        guardado,
        resultado: receitas - despesas, // guardado é memo, não reduz o resultado
        margem,
        isCritical: receitas > 0 && despesas / receitas > 0.9,
      };
    });

    const realizedRows = monthRows.filter((row) => row.monthIndex <= realizedUntil);
    const totalEntrouAno = sumBy(realizedRows, (row) => row.receitas);
    const totalSaiuAno = sumBy(realizedRows, (row) => row.despesas);
    const totalGuardadoAno = sumBy(realizedRows, (row) => row.guardado);
    const resultadoAcumulado = totalEntrouAno - totalSaiuAno; // guardado é memo
    const mediaMensal = realizedUntil > 0 ? Math.round(totalSaiuAno / realizedUntil) : 0;

    const serie = monthRows.map((row) => {
      const isFutureProjection = realizedUntil > 0 && row.monthIndex > realizedUntil;
      const receitaProjetada = row.receitas + row.receitasPlanejadas;
      const despesaProjetada = row.despesas + row.despesasPlanejadas;
      const margemProjetada = receitaProjetada - despesaProjetada;
      return {
        mes: row.mes,
        receita: isFutureProjection ? null : row.receitas,
        despesa: isFutureProjection ? null : row.despesas,
        projecaoReceita: receitaProjetada,
        projecaoDespesa: despesaProjetada,
        margem: isFutureProjection ? null : row.margem,
        projecaoMargem: margemProjetada,
        isCritical: receitaProjetada > 0 && despesaProjetada / receitaProjetada > 0.9,
      };
    });

    const mesCriticoBase = realizedRows.length > 0
      ? [...realizedRows].sort((a, b) => a.margem - b.margem)[0]
      : monthRows[0];

    // ── Série de saldo acumulado (eixo CAIXA), reconciliada com caixaHoje ──
    // Fonte: getAccountView(mês) — a MESMA agregação da Visão Conta, que é o
    // controlador universal do caixa e INCLUI débitos cross-project (despesas de
    // outros projetos pagas pela conta pessoal). Read-only; não altera nenhuma
    // regra de caixa. (O fold anterior sobre `normalized` era PESSOAL/competência
    // e não enxergava cross-project, subestimando o saldo projetado — bug corrigido.)
    //
    // Por mês M:
    //   netRealizado(M) = entrouMes − saiuMes                         (só pago/em caixa)
    //   netProjetado(M) = (entrouMes + recebPrevistos) − (saiuMes + faltaPagar)
    // Calibração: saldoAno0 = caixaHoje − Σ netRealizado(jan..mês corrente),
    // de modo que o Saldo Realizado do mês corrente == caixaHoje. `caixaHoje` é
    // constante entre os meses (saldo real de hoje); lemos da view do mês selecionado.
    const monthlyViews = await Promise.all(
      months.map((mes) =>
        mes === mesSelecionado
          ? Promise.resolve(accountView)
          : this.computeAccountView(tenantId, hub, mes, today),
      ),
    );
    const caixaHojeAtual = accountView.caixaHoje;
    const netRealizadoMes = (view: { entrouMes: number; saiuMes: number }) =>
      view.entrouMes - view.saiuMes;
    const saldoAno0 =
      caixaHojeAtual -
      monthlyViews.reduce(
        (sum, view, index) => (index + 1 <= realizedUntil ? sum + netRealizadoMes(view) : sum),
        0,
      );

    let accProjetado = saldoAno0;
    let accRealizado = saldoAno0;
    const saldoAcumuladoSerie = months.map((mes, index) => {
      const monthIndex = index + 1;
      const isFuture = monthIndex > realizedUntil;
      const view = monthlyViews[index];
      const recebimentosRealizados = view.entrouMes;
      const despesasRealizadas = view.saiuMes;
      const recebimentos = view.entrouMes + view.recebimentosPrevistosMes;
      const despesas = view.saiuMes + view.faltaPagarMes;
      // Breakdown das saídas do mês por categoria (tipo de despesa) — mesma
      // agregação da Visão Conta "por categoria". Fatura de cartão vira bucket
      // próprio (agrega vários tipos). O front rotula via tipoLabel.
      const despesasPorCategoria: Record<string, number> = {};
      for (const s of view.saidas) {
        const key = s.isInvoice ? '__fatura__' : s.tipoDespesa || '__sem__';
        despesasPorCategoria[key] = (despesasPorCategoria[key] ?? 0) + s.valor;
      }
      // ponytail: fixoLiquido = receitas planejadas − despesas planejadas (compromissos fixos).
      // Usado pelo simulador para recalcular barras quando ritmo muda.
      // derivado da MESMA série, sem 2º motor.
      const fixoLiquido = recebimentos - despesas;
      accProjetado += recebimentos - despesas;
      if (!isFuture) accRealizado += recebimentosRealizados - despesasRealizadas;
      return {
        mes,
        recebimentos,
        despesas,
        recebimentosRealizados: isFuture ? null : recebimentosRealizados,
        despesasRealizadas: isFuture ? null : despesasRealizadas,
        saldoProjetado: accProjetado,
        saldoRealizado: isFuture ? null : accRealizado,
        despesasPorCategoria,
        fixoLiquido,
      };
    });

    // ── Deep-dive: despesas do mês por ORIGEM de pagamento (barras empilhadas) ──
    // Reusa os account-views mensais já carregados. Cada saída é atribuída a:
    //  - Cartão (nickname/last4) quando é fatura de cartão (isInvoice);
    //  - Conta Corrente quando é débito direto de conta (bankLast4, não-fatura);
    //  - Outros quando não há origem identificável (ex.: planejado cross-project
    //    sem conta/cartão associado).
    // isFuture segue a mesma convenção do saldo (mês projetado → opacidade reduzida
    // no gráfico). `origens` = total (realizado + planejado); `origensRealizado` =
    // só as saídas já pagas — o front escolhe qual usar pelo toggle Projetado/Realizado.
    const CONTA_ORIGEM_LABEL = 'Conta Corrente';
    const OUTROS_ORIGEM_LABEL = 'Outros';
    const origemCartaoLabel = (last4: string) =>
      cardByLast4.get(last4)?.nickname?.trim() || `Cartão ••${last4}`;
    const despesasPorOrigemSerie = months.map((mes, index) => {
      const view = monthlyViews[index];
      const origens: Record<string, number> = {};
      const origensRealizado: Record<string, number> = {};
      for (const s of view.saidas) {
        const key =
          s.isInvoice && s.cardLast4
            ? origemCartaoLabel(s.cardLast4)
            : s.bankLast4 && !s.isInvoice
              ? CONTA_ORIGEM_LABEL
              : OUTROS_ORIGEM_LABEL;
        origens[key] = (origens[key] ?? 0) + s.valor;
        if (s.realizado) origensRealizado[key] = (origensRealizado[key] ?? 0) + s.valor;
      }
      return { mes, isFuture: index + 1 > realizedUntil, origens, origensRealizado };
    });
    // Colunas estáveis (todas as origens vistas no ano), ordenadas:
    // Conta Corrente primeiro, cartões em ordem alfabética, Outros por último.
    const origemSet = new Set<string>();
    for (const row of despesasPorOrigemSerie) {
      for (const k of Object.keys(row.origens)) origemSet.add(k);
    }
    const cartaoOrigemKeys = Array.from(origemSet)
      .filter((k) => k !== CONTA_ORIGEM_LABEL && k !== OUTROS_ORIGEM_LABEL)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const origensDespesa = [
      ...(origemSet.has(CONTA_ORIGEM_LABEL) ? [CONTA_ORIGEM_LABEL] : []),
      ...cartaoOrigemKeys,
      ...(origemSet.has(OUTROS_ORIGEM_LABEL) ? [OUTROS_ORIGEM_LABEL] : []),
    ];

    const totaisEntradas = groupAnnualTotals(
      normalized.filter(
        (line) =>
          line.kind === 'entrada' &&
          line.realizado &&
          line.mesCompetencia.startsWith(`${anoSelecionado}-`) &&
          monthNumber(line.mesCompetencia) <= realizedUntil,
      ),
      (line) => line.sourceLabel ?? 'Outros',
      (line) => ({
        label: line.sourceLabel ?? 'Outros',
        icon: line.sourceIcon ?? 'wallet',
        color: '#1D9E75',
      }),
      Math.max(realizedUntil, 1),
    );
    const totaisSaidas = groupAnnualTotals(
      normalized.filter(
        (line) =>
          line.kind === 'saida' &&
          line.realizado &&
          !line.isGuardado &&
          line.mesCompetencia.startsWith(`${anoSelecionado}-`) &&
          monthNumber(line.mesCompetencia) <= realizedUntil,
      ),
      (line) => line.group ?? 'Outros',
      (line) => ({
        label: line.group ?? 'Outros',
        icon: line.icon ?? 'coins',
        color: line.color ?? '#D85A30',
      }),
      Math.max(realizedUntil, 1),
    );
    const totaisGuardado = groupAnnualTotals(
      normalized.filter(
        (line) =>
          line.kind === 'saida' &&
          line.realizado &&
          line.isGuardado &&
          line.mesCompetencia.startsWith(`${anoSelecionado}-`) &&
          monthNumber(line.mesCompetencia) <= realizedUntil,
      ),
      (line) => line.group ?? 'Guardado',
      (line) => ({
        label: line.group ?? 'Guardado',
        icon: line.icon ?? 'piggy-bank',
        color: '#BA7517',
      }),
      Math.max(realizedUntil, 1),
    );

    return {
      mensal: {
        mes: mesSelecionado,
        resultado: resultadoMes,
        deltaVsMesAnterior,
        totalEntrou,
        totalSaiuMaisGuardou: totalSaiuCompetencia + totalGuardadoMes,
        receitaTotal: totalEntrou,
        despesaTotal: totalSaiuCompetencia,
        margemPct: totalEntrou > 0 ? roundPct((totalSaiuCompetencia / totalEntrou) * 100) : 0,
        entradas: entradasMes.map((line) => ({ label: line.label, valor: line.valor })),
        entradasConta: entradasConta.map((line) => ({ label: line.label, valor: line.valor })),
        saidas: saidasCompetencia,
        saidasCaixa,
        guardado: guardadoMes.map((line) => ({ label: line.label, valor: line.valor })),
        contaCorrente: contaCorrenteResumo,
      },
      anual: {
        ano: anoSelecionado,
        ateOMes: `jan–${monthShortLabel(Math.max(realizedUntil, 1))}`,
        totalEntrou: totalEntrouAno,
        totalSaiu: totalSaiuAno,
        totalGuardadoAno, // memo informativo: quanto foi guardado (investido) no ano
        resultadoAcumulado,
        mediaMensal,
        mesCritico: {
          mes: mesCriticoBase?.mes ?? `${anoSelecionado}-01`,
          margem: mesCriticoBase?.margem ?? 0,
        },
        serie,
        caixaHoje: accountView.caixaHoje,
        saldoAcumuladoOpening: saldoAno0,
        saldoAcumuladoSerie,
        despesasPorOrigem: { origens: origensDespesa, serie: despesasPorOrigemSerie },
        totaisEntradas,
        totaisSaidas,
        totaisGuardado,
        candidatos: buildRunwayCandidatos(saldoAcumuladoSerie, monthlyViews, months, mesSelecionado),
      },
    };
  }

  /**
   * Faturas de cartão e gastos de conta corrente por mês, ao longo de um ano.
   * Usado pela visão "ano todo" da Visão Conta: gráfico de barras com um mês por
   * coluna e uma barra por origem (cada cartão + cada conta corrente).
   *
   * Mesma regra de agregação da fatura em getAccountView:
   * - Cartão: agrupa por mês de VENCIMENTO (caixaMonthForCardPurchase) e inclui
   *   cobranças neutras lançadas COMO COMPRA no cartão (cardLast4 setado, sem
   *   bankLast4 — ex.: "Pix no crédito"), espelhando o banco; neutros liquidados
   *   via conta (bankLast4 setado) ficam de fora.
   * - Conta corrente: agrupa pelo mês do lançamento (débito na conta); exclui
   *   TODOS os neutros (pagamento de fatura / movimentação interna são
   *   transferências, não gasto novo).
   */
  async getCardInvoicesYearly(
    tenantId: string,
    projectId: string,
    year?: string | number,
    requester?: MonthlyOverviewRequester,
  ) {
    await this.ensurePessoalProject(tenantId, projectId, requester);

    const targetYear = normalizeYear(year);

    const [entries, cards, accounts, invoiceAdjustments] = await Promise.all([
      this.prisma.cashFlowEntry.findMany({
        where: {
          tenantId,
          projectId,
          deletedAt: null,
          tipo: 'DESPESA',
          AND: [{ OR: [{ expenseId: null }, { expense: { deletedAt: null } }] }],
        },
        select: {
          valor: true,
          data: true,
          expense: {
            select: { cardLast4: true, bankLast4: true, tipoDespesa: true, settlesInvoiceKey: true },
          },
        },
      }),
      this.prisma.creditCard.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: { nickname: true, last4: true, closingDay: true, dueDay: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.bankAccount.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: { nickname: true, institution: true, last4: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.invoiceAdjustment.findMany({
        where: {
          tenantId,
          projectId,
          deletedAt: null,
          dueMonth: { startsWith: `${targetYear}-` },
          reason: { not: 'QUITACAO_RESIDUO' },
        },
        select: { dueMonth: true, cardLast4: true, amountCents: true },
      }),
    ]);

    const cardByLast4 = new Map(cards.map((card) => [card.last4, card] as const));

    // Contas correntes deduplicadas por last4 (pode haver mais de um registro com
    // o mesmo last4; juntamos os apelidos para rotular a série única).
    const accountNamesByLast4 = new Map<string, Set<string>>();
    for (const account of accounts) {
      if (!account.last4) continue;
      const label = account.nickname?.trim() || account.institution?.trim();
      const set = accountNamesByLast4.get(account.last4) ?? new Set<string>();
      if (label) set.add(label);
      accountNamesByLast4.set(account.last4, set);
    }

    const originKey = (kind: 'card' | 'conta' | 'carteira', last4: string) =>
      kind === 'carteira' ? 'carteira' : `${kind}:${last4}`;

    // Mapa: `${YYYY-MM}__${originKey}` -> total em centavos (apenas o ano alvo).
    const totalsByMonthOrigin = new Map<string, number>();
    // Idem, mas só a parcela que é TRANSFERÊNCIA entre cartões ("cartão paga cartão"):
    // cobrança neutra no cartão com `settlesInvoiceKey`, isto é, quita a fatura de OUTRO
    // cartão. Compõe a fatura (contrato §7-1) e por isso permanece em `totalsByMonthOrigin`,
    // mas somar as faturas de todos os cartões conta esse dinheiro duas vezes (as compras
    // originais já estão na fatura de origem). Exposto à parte para a tela poder qualificar
    // o total agregado SEM alterar o valor de nenhuma fatura.
    const transfersByMonthOrigin = new Map<string, number>();
    const cardsWithData = new Set<string>();
    const accountsWithData = new Set<string>();
    let carteiraHasData = false;

    for (const entry of entries) {
      const cardLast4 = entry.expense?.cardLast4;
      const bankLast4 = entry.expense?.bankLast4;
      const tipo = entry.expense?.tipoDespesa;

      let key: string;
      let mes: string;
      let isCardTransfer = false;

      if (cardLast4) {
        // Cartão: neutros liquidados via conta ficam de fora; cobrança neutra no
        // cartão entra. Agrupa por mês de vencimento.
        if (isNeutralExpenseType(tipo) && bankLast4) continue;
        const card = cardByLast4.get(cardLast4) ?? null;
        mes = caixaMonthForCardPurchase(entry.data, card?.closingDay ?? null, card?.dueDay ?? null);
        key = originKey('card', cardLast4);
        cardsWithData.add(cardLast4);
        // "Cartão paga cartão": cobrança no cartão que quita a fatura de outro.
        isCardTransfer = !bankLast4 && !!entry.expense?.settlesInvoiceKey;
      } else if (bankLast4) {
        // Conta corrente: exclui neutros de consumo (settlement de fatura E aporte de
        // investimento — nenhum é "gasto da conta"); agrupa pelo mês do débito.
        if (isConsumptionNeutralExpenseType(tipo)) continue;
        mes = monthKeyOf(entry.data);
        key = originKey('conta', bankLast4);
        accountsWithData.add(bankLast4);
      } else {
        // Sem cartão E sem conta = "Carteira" (ex.: lançada por voz sem meio de
        // pagamento). Regra de ouro 14: nunca sumir com origin:'none' em silêncio.
        // Mesma regra da conta (neutro de consumo fora, mês por competência), igual
        // ao que getAllOriginItemsYearly já faz na lista da mesma tela.
        if (isConsumptionNeutralExpenseType(tipo)) continue;
        mes = monthKeyOf(entry.data);
        key = originKey('carteira', '');
        carteiraHasData = true;
      }

      if (!mes.startsWith(`${targetYear}-`)) continue;
      const mapKey = `${mes}__${key}`;
      totalsByMonthOrigin.set(mapKey, (totalsByMonthOrigin.get(mapKey) ?? 0) + entry.valor);
      if (isCardTransfer) {
        transfersByMonthOrigin.set(mapKey, (transfersByMonthOrigin.get(mapKey) ?? 0) + entry.valor);
      }
    }

    for (const adjustment of invoiceAdjustments) {
      const key = originKey('card', adjustment.cardLast4);
      const mapKey = `${adjustment.dueMonth}__${key}`;
      totalsByMonthOrigin.set(mapKey, (totalsByMonthOrigin.get(mapKey) ?? 0) + adjustment.amountCents);
      cardsWithData.add(adjustment.cardLast4);
    }

    // Origens a exibir: cartões cadastrados (+ denormalizados com dado), depois
    // contas cadastradas (+ denormalizadas com dado).
    const cardLast4Order = [
      ...cards.map((card) => card.last4),
      ...Array.from(cardsWithData).filter((last4) => !cardByLast4.has(last4)),
    ];
    const accountLast4Order = [
      ...Array.from(accountNamesByLast4.keys()),
      ...Array.from(accountsWithData).filter((last4) => !accountNamesByLast4.has(last4)),
    ];

    const origins = [
      ...cardLast4Order.map((last4) => ({
        key: originKey('card', last4),
        kind: 'card' as const,
        last4,
        nickname: cardByLast4.get(last4)?.nickname?.trim() || `Cartão ${last4}`,
      })),
      ...accountLast4Order.map((last4) => ({
        key: originKey('conta', last4),
        kind: 'conta' as const,
        last4,
        nickname:
          Array.from(accountNamesByLast4.get(last4) ?? []).join(' / ') || `Conta ${last4}`,
      })),
      ...(carteiraHasData
        ? [{ key: originKey('carteira', ''), kind: 'carteira' as const, last4: '', nickname: 'Carteira' }]
        : []),
    ];

    const monthLabels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const months = Array.from({ length: 12 }, (_, index) => {
      const mes = `${targetYear}-${String(index + 1).padStart(2, '0')}`;
      const porOrigem: Record<string, number> = {};
      const transferenciasPorOrigem: Record<string, number> = {};
      let total = 0;
      for (const origin of origins) {
        const value = totalsByMonthOrigin.get(`${mes}__${origin.key}`) ?? 0;
        porOrigem[origin.key] = value;
        transferenciasPorOrigem[origin.key] = transfersByMonthOrigin.get(`${mes}__${origin.key}`) ?? 0;
        total += value;
      }
      return { mes, label: monthLabels[index], porOrigem, transferenciasPorOrigem, total };
    });

    const totalAno = months.reduce((sum, month) => sum + month.total, 0);
    const transferenciasAno = Array.from(transfersByMonthOrigin.values()).reduce((sum, v) => sum + v, 0);

    return { year: targetYear, origins, months, totalAno, transferenciasAno };
  }

  /**
   * Despesas relacionadas a UMA origem (cartão ou conta corrente) ao longo de um
   * ano — usado para listar abaixo do gráfico quando o usuário filtra por origem.
   * Aplica a MESMA regra de neutros/mês do getCardInvoicesYearly.
   *
   * Quando `kind === 'all'`, agrega TODAS as origens (cartões + contas) no ano,
   * anexando o rótulo de origem (`origem`) em cada item — usado pela opção
   * "Todos" da Visão Conta (com filtros de tipo de despesa e mês no frontend).
   */
  /**
   * Lista TODOS os lançamentos neutros do PESSOAL (entradas e saídas) num ano,
   * para a visão "Neutros". Neutro = não entra em consumo/renda dos KPIs, mas é
   * caixa real. Cobre:
   *  - Despesas com tipo neutro-de-consumo (PAGAMENTO_FATURA_CARTAO,
   *    MOVIMENTACAO_INTERNA, INVESTIMENTOS, PAGAMENTO_CASA);
   *  - Recebimentos com tipo neutro (RESGATE, TRANSFERENCIA_PROPRIA).
   * Cada item carrega o id REAL da Expense/Receipt para editar valor/excluir
   * pelos endpoints existentes (que já regeneram o cashflow).
   */
  async getNeutros(
    tenantId: string,
    projectId: string,
    yearParam?: string | number,
    requester?: MonthlyOverviewRequester,
  ) {
    await this.ensurePessoalProject(tenantId, projectId, requester);
    const year = normalizeYear(yearParam);
    const [yStart, yEnd] = [
      new Date(Date.UTC(year, 0, 1)),
      new Date(Date.UTC(year + 1, 0, 1)),
    ];

    const [expenses, receipts] = await Promise.all([
      this.prisma.expense.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
          id: true,
          tipoDespesa: true,
          titulo: true,
          fornecedor: true,
          valor: true,
          valorTotal: true,
          quantidade: true,
          formaPagamento: true,
          quantidadeParcela: true,
          paidParcelas: true,
          installmentDateOverrides: true,
          dataPagamento: true,
          dataInicioParcela: true,
          dataCompra: true,
          createdAt: true,
          status: true,
          cardLast4: true,
          bankLast4: true,
        },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
          id: true,
          tipo: true,
          descricao: true,
          valor: true,
          data: true,
          status: true,
          bankLast4: true,
        },
      }),
    ]);

    const inYear = (d: Date | null) => !!d && d >= yStart && d < yEnd;
    const expenseDate = (e: {
      dataPagamento: Date | null;
      dataInicioParcela: Date | null;
      dataCompra: Date | null;
      createdAt: Date;
    }) => e.dataPagamento ?? e.dataInicioParcela ?? e.dataCompra ?? e.createdAt;

    const saidas = expenses
      .filter((expense) => isConsumptionNeutralExpenseType(expense.tipoDespesa))
      .flatMap((expense) => {
        if (isSinglePaymentForm(expense.formaPagamento)) {
          return [
            {
              expense,
              data: expenseDate(expense),
              valorTotal: expense.valorTotal,
              valorUnitario: expense.valor,
              quantidade: expense.quantidade,
              status: expense.status,
              parcelaIndex: null as number | null,
            },
          ];
        }

        const installments = buildInstallments({
          formaPagamento: expense.formaPagamento,
          quantidadeParcela: expense.quantidadeParcela,
          valorTotal: expense.valorTotal,
          dataInicioParcela: expense.dataInicioParcela,
          dataPagamento: expense.dataPagamento,
          installmentDateOverrides: expense.installmentDateOverrides,
        });
        const paidParcelas = new Set(
          parsePaidParcelas(expense.paidParcelas, installments.length),
        );
        return installments.map((installment, index) => ({
          expense,
          data: installment.data,
          valorTotal: installment.valor,
          valorUnitario: installment.valor,
          quantidade: 1,
          status:
            expense.status === 'PAGO' || paidParcelas.has(index)
              ? 'PAGO'
              : 'PLANEJADO',
          parcelaIndex: index as number | null,
        }));
      })
      .filter(({ data }) => inYear(data))
      .map(
        ({
          expense,
          data,
          valorTotal,
          valorUnitario,
          quantidade,
          status,
          parcelaIndex,
        }) => ({
          id: expense.id,
          kind: 'saida' as const,
          tipo: expense.tipoDespesa,
          tipoLabel:
            ExpenseTypeLabels[expense.tipoDespesa as keyof typeof ExpenseTypeLabels] ??
            expense.tipoDespesa,
          descricao:
            expense.titulo?.trim() ||
            expense.fornecedor?.trim() ||
            ExpenseTypeLabels[expense.tipoDespesa as keyof typeof ExpenseTypeLabels] ||
            expense.tipoDespesa,
          valorTotal,
          valorUnitario,
          quantidade,
          data: data.toISOString(),
          status,
          cardLast4: expense.cardLast4,
          bankLast4: expense.bankLast4,
          parcelaIndex,
          // Settlement (fatura/movimentação) não gera cashflow; consumo-neutro (aporte)
          // continua no caixa. Sinaliza para o front explicar o efeito no caixa.
          afetaCaixa: !isNeutralExpenseType(expense.tipoDespesa),
        }),
      );

    const entradas = receipts
      .filter((r) => isNeutralReceiptType(r.tipo))
      .filter((r) => inYear(r.data))
      .map((r) => ({
        id: r.id,
        kind: 'entrada' as const,
        tipo: r.tipo,
        tipoLabel: ReceiptTypeLabels[r.tipo as keyof typeof ReceiptTypeLabels] ?? r.tipo,
        descricao:
          r.descricao?.trim() ||
          ReceiptTypeLabels[r.tipo as keyof typeof ReceiptTypeLabels] ||
          r.tipo,
        valorTotal: r.valor,
        valorUnitario: r.valor,
        quantidade: 1,
        data: r.data.toISOString(),
        status: r.status,
        cardLast4: null as string | null,
        bankLast4: r.bankLast4,
        afetaCaixa: true, // resgate/transferência própria são crédito real no caixa
      }));

    const itens = [...saidas, ...entradas].sort((a, b) => b.data.localeCompare(a.data));
    const totalEntradas = entradas.reduce((s, i) => s + i.valorTotal, 0);
    const totalSaidas = saidas.reduce((s, i) => s + i.valorTotal, 0);

    return {
      year,
      totalEntradas,
      totalSaidas,
      totalLiquido: totalEntradas - totalSaidas,
      itens,
    };
  }

  /**
   * Itens debitados na CONTA que não devem sequer aparecer na lista de despesas.
   *
   * Settlement (pagamento de fatura, movimentação interna) e `PAGAMENTO_CASA`
   * ficam de fora — a compra real já está no cartão / no outro projeto.
   * `INVESTIMENTOS`, porém, ENTRA: o dinheiro saiu da conta de verdade e a
   * despesa tem que continuar visível (o toggle "mostrar investimentos" da tela
   * é quem decide exibir ou não). Antes usava-se `isConsumptionNeutral`, que
   * engolia investimento junto e fazia a despesa sumir ao trocar a categoria.
   */
  private isHiddenFromAccountItems(tipo: string): boolean {
    return isConsumptionNeutralExpenseType(tipo) && tipo !== ExpenseType.INVESTIMENTOS;
  }

  async getOriginItemsYearly(
    tenantId: string,
    projectId: string,
    params: { year?: string | number; kind?: string; last4?: string },
    requester?: MonthlyOverviewRequester,
  ) {
    await this.ensurePessoalProject(tenantId, projectId, requester);

    const targetYear = normalizeYear(params.year);
    if (params.kind === 'all') {
      return this.getAllOriginItemsYearly(tenantId, projectId, targetYear);
    }
    const kind = params.kind === 'conta' ? 'conta' : 'card';
    const last4 = (params.last4 ?? '').trim();
    if (!last4) throw new BadRequestException('Parâmetro last4 é obrigatório.');

    const projects = await this.prisma.project.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    const projectById = new Map(projects.map((p) => [p.id, p] as const));

    const card =
      kind === 'card'
        ? // B1b (#448): leitura pura de ciclo (`closingDay`/`dueDay`) para montar
          // a lista anual — sem 409 de final ambíguo, de propósito. Nada é
          // decidido nem escrito aqui, e a recusa só apagaria uma listagem
          // legítima. Quem oferece VERBO sobre fatura (`computeAccountView`)
          // é que suprime `actions`/`cardId` no final ambíguo.
          await this.prisma.creditCard.findFirst({
            where: { tenantId, projectId, last4, deletedAt: null },
            select: { closingDay: true, dueDay: true },
          })
        : null;

    const entries = await this.prisma.cashFlowEntry.findMany({
      where: {
        tenantId,
        projectId,
        deletedAt: null,
        tipo: 'DESPESA',
        expense: {
          deletedAt: null,
          ...(kind === 'card' ? { cardLast4: last4 } : { bankLast4: last4, cardLast4: null }),
        },
      },
      select: {
        valor: true,
        data: true,
        status: true,
        expense: {
          select: {
            tipoDespesa: true,
            titulo: true,
            fornecedor: true,
            cardLast4: true,
            bankLast4: true,
            linkedExpenseId: true,
            project: { select: { id: true, name: true, type: true } },
          },
        },
      },
      orderBy: [{ data: 'desc' }],
    });

    const items: Array<{
      mes: string;
      data: string;
      descricao: string;
      valor: number;
      tipoDespesa: string;
      status: string;
      projetoOrigem: { id: string; name: string; type: string } | null;
    }> = [];

    for (const entry of entries) {
      const tipo = entry.expense?.tipoDespesa ?? 'OUTROS';
      let mes: string;
      if (kind === 'card') {
        if (isNeutralExpenseType(tipo) && entry.expense?.bankLast4) continue;
        mes = caixaMonthForCardPurchase(entry.data, card?.closingDay ?? null, card?.dueDay ?? null);
      } else {
        if (this.isHiddenFromAccountItems(tipo)) continue;
        mes = monthKeyOf(entry.data);
      }
      if (!mes.startsWith(`${targetYear}-`)) continue;

      const linkedExpenseId = entry.expense?.linkedExpenseId ?? null;
      const linkedProject = entry.expense?.project ?? null;
      const projetoOrigem =
        linkedExpenseId && linkedProject
          ? { id: linkedProject.id, name: linkedProject.name, type: linkedProject.type }
          : null;

      items.push({
        mes,
        data: entry.data.toISOString(),
        descricao: expenseDisplayName(tipo, entry.expense?.titulo ?? null, entry.expense?.fornecedor ?? null),
        valor: entry.valor,
        tipoDespesa: tipo,
        status: entry.status,
        projetoOrigem,
      });
    }

    void projectById; // projetoOrigem usa expense.project diretamente (mesmo projeto = PESSOAL)
    // Investimento agora aparece na lista, mas é aporte, não gasto: fica fora do
    // total da CONTA. No cartão, tudo que foi cobrado compõe a fatura e soma.
    const total = items.reduce(
      (sum, item) =>
        kind !== 'card' && isConsumptionNeutralExpenseType(item.tipoDespesa)
          ? sum
          : sum + item.valor,
      0,
    );

    return { year: targetYear, kind, last4, items, total };
  }

  /**
   * Variante "Todos" do getOriginItemsYearly: agrega TODAS as origens (cartões +
   * contas) do ano num único conjunto de itens, cada um com seu rótulo de origem.
   * Mantém EXATAMENTE as mesmas regras de neutro/mês por tipo de origem:
   *  - cartão: pula settlement liquidado na conta (isNeutralExpenseType && bankLast4);
   *    mês = vencimento da fatura (caixaMonthForCardPurchase);
   *  - conta: pula neutro-de-consumo (settlement + aporte); mês = competência do débito.
   */
  private async getAllOriginItemsYearly(
    tenantId: string,
    projectId: string,
    targetYear: number,
  ) {
    const [cards, accounts, entries] = await Promise.all([
      this.prisma.creditCard.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: { nickname: true, last4: true, closingDay: true, dueDay: true },
      }),
      this.prisma.bankAccount.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: { nickname: true, institution: true, last4: true },
      }),
      this.prisma.cashFlowEntry.findMany({
        where: {
          tenantId,
          projectId,
          deletedAt: null,
          tipo: 'DESPESA',
          expense: { deletedAt: null },
        },
        select: {
          valor: true,
          data: true,
          status: true,
          expense: {
            select: {
              tipoDespesa: true,
              titulo: true,
              fornecedor: true,
              cardLast4: true,
              bankLast4: true,
              linkedExpenseId: true,
              project: { select: { id: true, name: true, type: true } },
            },
          },
        },
        orderBy: [{ data: 'desc' }],
      }),
    ]);

    const cardByLast4 = new Map(cards.map((c) => [c.last4, c] as const));
    const accountNamesByLast4 = new Map<string, Set<string>>();
    for (const account of accounts) {
      if (!account.last4) continue;
      const label = account.nickname?.trim() || account.institution?.trim();
      const set = accountNamesByLast4.get(account.last4) ?? new Set<string>();
      if (label) set.add(label);
      accountNamesByLast4.set(account.last4, set);
    }

    const items: Array<{
      mes: string;
      data: string;
      descricao: string;
      valor: number;
      tipoDespesa: string;
      status: string;
      projetoOrigem: { id: string; name: string; type: string } | null;
      origem: { kind: 'card' | 'conta' | 'carteira'; last4: string; nickname: string };
    }> = [];

    for (const entry of entries) {
      const cardLast4 = entry.expense?.cardLast4;
      const bankLast4 = entry.expense?.bankLast4;
      const tipo = entry.expense?.tipoDespesa ?? 'OUTROS';

      let mes: string;
      let origem: { kind: 'card' | 'conta' | 'carteira'; last4: string; nickname: string };
      if (cardLast4) {
        if (isNeutralExpenseType(tipo) && bankLast4) continue;
        const card = cardByLast4.get(cardLast4) ?? null;
        mes = caixaMonthForCardPurchase(entry.data, card?.closingDay ?? null, card?.dueDay ?? null);
        origem = { kind: 'card', last4: cardLast4, nickname: card?.nickname?.trim() || `Cartão ${cardLast4}` };
      } else if (bankLast4) {
        if (this.isHiddenFromAccountItems(tipo)) continue;
        mes = monthKeyOf(entry.data);
        origem = {
          kind: 'conta',
          last4: bankLast4,
          nickname: Array.from(accountNamesByLast4.get(bankLast4) ?? []).join(' / ') || `Conta ${bankLast4}`,
        };
      } else {
        // Sem cartão E sem conta (ex.: lançada por voz sem meio de pagamento informado)
        // não é erro — é o "Carteira" que já existe em getAccountView ({ tipo: 'carteira' }).
        // Regra de ouro 14: nunca filtrar origin:'none' para fora em silêncio, ou o
        // dinheiro some do consolidado mesmo afetando o caixa real.
        mes = monthKeyOf(entry.data);
        origem = { kind: 'carteira', last4: '', nickname: 'Carteira' };
      }
      if (!mes.startsWith(`${targetYear}-`)) continue;

      const linkedExpenseId = entry.expense?.linkedExpenseId ?? null;
      const linkedProject = entry.expense?.project ?? null;
      const projetoOrigem =
        linkedExpenseId && linkedProject
          ? { id: linkedProject.id, name: linkedProject.name, type: linkedProject.type }
          : null;

      items.push({
        mes,
        data: entry.data.toISOString(),
        descricao: expenseDisplayName(tipo, entry.expense?.titulo ?? null, entry.expense?.fornecedor ?? null),
        valor: entry.valor,
        tipoDespesa: tipo,
        status: entry.status,
        projetoOrigem,
        origem,
      });
    }

    // Idem: aporte na conta/carteira não é gasto; cobrança no cartão compõe a fatura.
    const total = items.reduce(
      (sum, item) =>
        item.origem.kind !== 'card' && isConsumptionNeutralExpenseType(item.tipoDespesa)
          ? sum
          : sum + item.valor,
      0,
    );
    return { year: targetYear, kind: 'all' as const, last4: '', items, total };
  }

  /**
   * Caixa real da conta corrente — reconciliação §10 do consolidado financeiro:
   *
   *   saldo hoje = saldo inicial (das contas) + Σ lançamentos REALIZADOS da conta
   *
   * "Lançamento da conta" = qualquer Expense/Receipt com `bankLast4` preenchido
   * (extrato, aplicações/resgates e pagamentos de fatura debitados na conta).
   * Itens de cartão (cardLast4, sem bankLast4) NÃO entram — eles estão na fatura,
   * não na conta. Em parcelados, entram apenas ocorrências realizadas; lançamentos
   * futuros ficam de fora porque ainda não foram debitados.
   *
   * Diferente de "caixaAgora" do cockpit (fluxo realizado conta+cartão): este bate
   * com o saldo do app do banco quando o saldo inicial está cadastrado.
   */
  private async computeCaixaConta(
    tenantId: string,
    projectId: string,
    today: Date = todayLocalDateUtc(FINANCIAL_TIME_ZONE),
  ) {
    const [accounts, expenses, receipts] = await Promise.all([
      this.prisma.bankAccount.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
          id: true,
          openingBalanceCents: true,
          openingBalanceDate: true,
          last4: true,
          nickname: true,
          institution: true,
        },
      }),
      this.prisma.expense.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
          id: true,
          titulo: true,
          fornecedor: true,
          tipoDespesa: true,
          formaPagamento: true,
          quantidadeParcela: true,
          valorTotal: true,
          status: true,
          dataPagamento: true,
          dataInicioParcela: true,
          dataCompra: true,
          paidParcelas: true,
          installmentDateOverrides: true,
          createdAt: true,
          cardLast4: true,
          bankLast4: true,
          importId: true,
          linkedExpenseId: true,
          settledByExpenseId: true,
        },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: { valor: true, status: true, data: true, bankLast4: true, importId: true },
      }),
    ]);
    const primaryAccount = this.pickPrimaryBankAccount(accounts);
    const importAccountById = await this.getImportAccountMap(
      tenantId,
      accounts.map((account) => account.id),
    );
    const resolveMovementAccountId = this.buildAccountResolver(
      accounts,
      importAccountById,
      primaryAccount?.id ?? null,
    );
    const bankExpenses = expenses.filter(
      (expense) =>
        !!expense.bankLast4 &&
        resolveMovementAccountId({
          bankLast4: expense.bankLast4,
          importId: expense.importId ?? null,
        }) === (primaryAccount?.id ?? null),
    );
    const bankReceipts = receipts.filter(
      (receipt) =>
        !!receipt.bankLast4 &&
        resolveMovementAccountId({
          bankLast4: receipt.bankLast4,
          importId: receipt.importId ?? null,
        }) === (primaryAccount?.id ?? null),
    );
    const caixa = computeCaixaConta(
      primaryAccount ? [primaryAccount] : accounts,
      bankExpenses,
      bankReceipts,
      today,
    );
    const { carteiraHoje } = this.buildCarteiraSnapshot(expenses, receipts, today);

    // Conta que ANCORA o §10 (`pickPrimaryBankAccount`). Quem exibe o número
    // precisa saber a QUE conta ele se refere; sem isto cada consumidor
    // redecidiria "qual é a primária" por conta própria — que é exatamente a
    // classe de bug da #508 (segunda fórmula divergindo em silêncio). A decisão
    // é do motor, então é o motor que a publica. `null` = projeto sem conta.
    const contaPrimaria = primaryAccount
      ? {
          id: primaryAccount.id,
          nickname: primaryAccount.nickname,
          last4: primaryAccount.last4,
          institution: primaryAccount.institution,
        }
      : null;

    return { ...caixa, carteiraHoje, contaPrimaria };
  }

  /**
   * §10 (Caixa Conta) público — delegador do motor canônico congelado (`computeCaixaConta`).
   * Fonte ÚNICA do "caixa/saldo em conta" consumida pelos demais motores (tenant-financial).
   * Não lança para não-PESSOAL (só consulta por projectId), então o chamador DEVE
   * filtrar por `project.type === 'PESSOAL'` antes de chamar.
   *
   * Devolve também `carteiraHoje` e `contaPrimaria` (a conta que ancora o §10)
   * para que o consumidor rotule os números sem redecidir origem/primária.
   */
  async getCaixaConta(tenantId: string, projectId: string, today?: Date) {
    return this.computeCaixaConta(tenantId, projectId, today);
  }

  private pickPrimaryBankAccount(
    accounts: Array<{
      id: string;
      openingBalanceCents: number;
      openingBalanceDate: Date | null;
      last4: string;
      // `bank_accounts.nickname` é NOT NULL no schema e `createAccount` sempre
      // preenche um default — declarar `string | null` aqui só empurrava um
      // nulo impossível para quem ROTULA o saldo (#508).
      nickname: string;
      institution: string;
    }>,
  ) {
    if (accounts.length === 0) return null;

    // Conta primária = a âncora do saldo inicial do §10: aquela cujo saldo inicial
    // foi configurado (openingBalanceDate/openingBalanceCents). É de onde o §10
    // reconcilia o caixa; sem âncora, cai na primeira conta (ordem determinística).
    // ponytail: heurística por âncora, não por instituição. Se um dia houver >1 conta
    // ancorada no mesmo PESSOAL, promover a um BankAccount.isPrimary explícito.
    const anchored = accounts.find(
      (account) => account.openingBalanceDate != null || account.openingBalanceCents !== 0,
    );
    return anchored ?? accounts[0] ?? null;
  }

  private async getImportAccountMap(tenantId: string, accountIds: string[]) {
    if (accountIds.length === 0) return new Map<string, string>();
    const imports = await this.prisma.bankStatementImport.findMany({
      where: { tenantId, accountId: { in: accountIds }, deletedAt: null },
      select: { id: true, accountId: true },
    });
    return new Map(imports.map((row) => [row.id, row.accountId] as const));
  }

  private buildAccountResolver(
    accounts: Array<{ id: string; last4: string }>,
    importAccountById: Map<string, string>,
    fallbackAccountId: string | null,
  ) {
    const accountIdsByLast4 = new Map<string, string[]>();
    for (const account of accounts) {
      const current = accountIdsByLast4.get(account.last4) ?? [];
      current.push(account.id);
      accountIdsByLast4.set(account.last4, current);
    }

    return (movement: { bankLast4: string | null; importId: string | null }) => {
      if (!movement.bankLast4) return null;
      if (movement.importId) {
        const mapped = importAccountById.get(movement.importId);
        if (mapped) return mapped;
      }
      const candidates = accountIdsByLast4.get(movement.bankLast4) ?? [];
      if (candidates.length === 1) return candidates[0] ?? null;
      return fallbackAccountId;
    };
  }

  /**
   * Pagamento manual de fatura de cartão a partir da Visão Conta.
   *
   * Gera UMA despesa neutra `PAGAMENTO_FATURA_CARTAO` (PAGO, com `bankLast4` da
   * conta que debita) — o lado de saída do caixa §10 — e liquida as compras do
   * ciclo daquela fatura (PLANEJADO → PAGO) via `CardInvoiceSettlementService`.
   *
   * Invariantes respeitadas:
   *  - §0.2 neutralidade: o pagamento não é recontado junto da fatura projetada
   *    (o tipo neutro é excluído do agregado da fatura e da lista de saídas; a
   *    fatura projetada some de `faltaPagarMes` porque passa a constar como paga).
   *  - §0.7 fonte única: o saldo continua derivado de `computeCaixaConta`.
   *
   * `requester` (B0 #447) é OBRIGATÓRIO: a rota usa o param renomeado
   * `:pessoalProjectId`, que `ProjectAccessGuard` NÃO reconhece — a autorização
   * do anchor acontece aqui, ANTES de qualquer leitura/escrita, e `requester.id`
   * é a autoria auditada da despesa de pagamento.
   *
   * B1a (#448): `cardId`/`accountId` são OPCIONAIS. Quando presentes, resolvem
   * o cartão/conta ESTRITAMENTE por `{id, tenantId, projectId, deletedAt:null}`
   * (identidade completa, não mais ambígua por last4 duplicado). Quando
   * ausentes, preserva o fallback por last4 (compat legado). Se AMBOS vierem e
   * apontarem para registros diferentes, 400 sem escrita alguma — nunca
   * silenciosamente prioriza um dos dois.
   *
   * B1b (#448): o fallback legado deixou de ser `findFirst`. Com DOIS cartões
   * (ou contas) ativos de mesmo final no projeto — colisão que só existe em
   * dado legado, já que o guard do B1a impede criar outra — a resolução
   * responde **409** (`resolveUniqueLegacyMatch`) em vez de pagar o registro
   * que o banco devolvesse primeiro. A leitura combina: a Visão Conta não
   * oferece `actions` nem emite `cardId` para um final ambíguo.
   */
  async payInvoice(
    tenantId: string,
    projectId: string,
    dto: {
      cardId?: string;
      cardLast4?: string;
      month?: string;
      amountCents?: number;
      accountId?: string;
      bankLast4?: string;
      paymentDate?: string;
    },
    requester: MonthlyOverviewMutationRequester,
  ) {
    this.assertIdentifiedRequester(requester);
    await this.ensurePessoalProject(tenantId, projectId, requester);
    const createdByUserId = requester.id;

    const month = normalizeMonthKey(dto.month);
    if (!dto.cardId && !dto.cardLast4) throw new BadRequestException('Cartão obrigatório.');
    if (!dto.accountId && !dto.bankLast4) throw new BadRequestException('Conta de débito obrigatória.');
    if (!Number.isInteger(dto.amountCents) || (dto.amountCents ?? 0) <= 0) {
      throw new BadRequestException('Valor da fatura inválido.');
    }
    const amountCents = dto.amountCents as number;

    const parsedPaymentDate = dto.paymentDate ? new Date(dto.paymentDate) : new Date();
    if (Number.isNaN(parsedPaymentDate.getTime())) {
      throw new BadRequestException('Data de pagamento inválida.');
    }
    const effectiveDate = parsedPaymentDate;

    return this.prisma.$transaction(async (tx) => {
      const cardSelect = {
        id: true,
        last4: true,
        nickname: true,
        closingDay: true,
        dueDay: true,
      } as const;
      const card = dto.cardId
        ? await tx.creditCard.findFirst({
            where: { id: dto.cardId, tenantId, projectId, deletedAt: null },
            select: cardSelect,
          })
        : resolveUniqueLegacyMatch(
            await tx.creditCard.findMany({
              where: { tenantId, projectId, last4: dto.cardLast4, deletedAt: null },
              select: cardSelect,
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: 2,
            }),
            AMBIGUOUS_CARD_MESSAGE,
          );
      if (!card) throw new NotFoundException('Cartão não encontrado.');
      if (dto.cardId && dto.cardLast4 && card.last4 !== dto.cardLast4) {
        throw new BadRequestException('cardId e cardLast4 não correspondem ao mesmo cartão.');
      }

      const accountSelect = { id: true, last4: true } as const;
      const account = dto.accountId
        ? await tx.bankAccount.findFirst({
            where: { id: dto.accountId, tenantId, projectId, deletedAt: null },
            select: accountSelect,
          })
        : resolveUniqueLegacyMatch(
            await tx.bankAccount.findMany({
              where: { tenantId, projectId, last4: dto.bankLast4, deletedAt: null },
              select: accountSelect,
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: 2,
            }),
            AMBIGUOUS_ACCOUNT_MESSAGE,
          );
      if (!account) throw new NotFoundException('Conta de débito não encontrada.');
      if (dto.accountId && dto.bankLast4 && account.last4 !== dto.bankLast4) {
        throw new BadRequestException('accountId e bankLast4 não correspondem à mesma conta.');
      }

      // Idempotência por payload exato, relida na mesma transação da escrita.
      const existing = await tx.expense.findFirst({
        where: {
          tenantId,
          projectId,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          status: 'PAGO',
          cardLast4: card.last4,
          bankLast4: account.last4,
          valorTotal: amountCents,
          dataPagamento: effectiveDate,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (existing) {
        throw new BadRequestException('Este pagamento já foi registrado.');
      }

      const prepared = await this.cardSettlement.prepareSettleInvoice({
        tenantId,
        card,
        amountCents,
        paymentDate: effectiveDate,
        tx,
        requester,
      });
      const payment = await tx.expense.create({
        data: {
          tenantId,
          projectId,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          titulo: `Pagamento fatura ${card.nickname?.trim() || card.last4}`,
          fornecedor: `Fatura ${card.last4}`,
          valor: amountCents,
          quantidade: 1,
          valorTotal: amountCents,
          formaPagamento: 'A_VISTA',
          dataPagamento: effectiveDate,
          status: 'PAGO',
          bankLast4: account.last4,
          cardLast4: card.last4,
          createdByUserId,
        },
      });
      const settled = await this.cardSettlement.applyPreparedSettlement(tx, prepared);

      return {
        ok: true,
        paymentExpenseId: payment.id,
        cardId: card.id,
        cardLast4: card.last4,
        accountId: account.id,
        month,
        amountCents,
        ...settled,
      };
    });
  }

  /**
   * Desfaz um pagamento manual de fatura de cartão (`payInvoice`).
   *
   * Segurança: só desfaz quando existe EXATAMENTE UM pagamento implícito
   * (`PAGAMENTO_FATURA_CARTAO`, PAGO, com `bankLast4`, sem `settlesInvoiceKey`)
   * casado com a fatura-alvo — reaproveita `assignImplicitPayments` sobre a
   * lista de TODAS as faturas do cartão (`buildCardInvoiceAggregates`, a MESMA
   * agregação que decide `card.status` em `getAccountView`). Precisa ser a
   * lista inteira, não só a fatura-alvo: `assignImplicitPayments` decide por
   * DISPUTA entre faturas candidatas na janela `{payMonth, payMonth+1}` de cada
   * pagamento — com uma fatura só, pagamentos de OUTROS meses "vazam" pra cá.
   * 0 casamentos → 404. 2+ (ambíguo) → 400 com a lista dos pagamentos casados.
   *
   * `requester` (B0 #447) é OBRIGATÓRIO pela mesma razão de `payInvoice` — com o
   * param de rota renomeado (`:pessoalProjectId`) o guard global não cobre esta
   * mutação, então o scope do anchor é resolvido aqui antes de ler/reverter
   * qualquer pagamento.
   *
   * B1a (#448): `cardId` OPCIONAL — presente resolve estrito por
   * `{id, tenantId, projectId, deletedAt:null}`; ausente preserva o fallback
   * por last4. Mismatch cardId×cardLast4 é 400 sem escrita.
   *
   * B1b (#448): final legado ambíguo (>1 cartão ativo com aquele last4 no
   * projeto) responde **409** antes de qualquer leitura de pagamento — desfazer
   * a fatura do cartão errado é irreversível na prática.
   */
  async undoInvoicePayment(
    tenantId: string,
    projectId: string,
    dto: { cardId?: string; cardLast4?: string; dueMonth?: string },
    requester: MonthlyOverviewMutationRequester,
  ) {
    this.assertIdentifiedRequester(requester);
    await this.ensurePessoalProject(tenantId, projectId, requester);

    if (!dto.cardId && !dto.cardLast4) throw new BadRequestException('Cartão obrigatório.');
    if (!dto.dueMonth) throw new BadRequestException('Mês de vencimento obrigatório.');
    const dueMonth = normalizeMonthKey(dto.dueMonth);

    const undoCardSelect = { id: true, last4: true, nickname: true, closingDay: true, dueDay: true } as const;
    const card = dto.cardId
      ? await this.prisma.creditCard.findFirst({
          where: { id: dto.cardId, tenantId, projectId, deletedAt: null },
          select: undoCardSelect,
        })
      : resolveUniqueLegacyMatch(
          await this.prisma.creditCard.findMany({
            where: { tenantId, projectId, last4: dto.cardLast4, deletedAt: null },
            select: undoCardSelect,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 2,
          }),
          AMBIGUOUS_CARD_MESSAGE,
        );
    if (!card) throw new NotFoundException('Cartão não encontrado.');
    if (dto.cardId && dto.cardLast4 && card.last4 !== dto.cardLast4) {
      throw new BadRequestException('cardId e cardLast4 não correspondem ao mesmo cartão.');
    }

    // Lista TODAS as faturas do cartão (todo mês com CashFlowEntry/ajuste), não só a
    // fatura-alvo — a MESMA lista que `getAccountView` monta via
    // `buildCardInvoiceAggregates`. Com uma fatura só na lista, `assignImplicitPayments`
    // não tinha concorrente pro pagamento de OUTRO mês cuja janela [payMonth, payMonth+1]
    // alcançasse o dueMonth-alvo, e forçava esse pagamento pra cá — ambiguidade falsa
    // sempre que o cartão tinha pagamento no mês anterior (o caso normal, não o raro).
    const [cardEntries, cardInvoiceAdjustments] = await Promise.all([
      this.prisma.cashFlowEntry.findMany({
        where: {
          tenantId,
          projectId,
          deletedAt: null,
          tipo: 'DESPESA',
          expense: { deletedAt: null, cardLast4: card.last4 },
        },
        select: {
          tipo: true,
          data: true,
          valor: true,
          expense: { select: { cardLast4: true, bankLast4: true, tipoDespesa: true } },
        },
      }),
      this.prisma.invoiceAdjustment.findMany({
        where: { tenantId, projectId, deletedAt: null, cardLast4: card.last4 },
        select: { cardLast4: true, dueMonth: true, amountCents: true, reason: true },
      }),
    ]);
    const invoices: InvoiceForMatch[] = Array.from(
      buildCardInvoiceAggregates(cardEntries, [card], cardInvoiceAdjustments).values(),
    ).map((invoice) => ({ dueMonth: invoice.dueMonth, cardLast4: invoice.cardLast4, total: invoice.total }));

    const candidates = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        cardLast4: card.last4,
        status: 'PAGO',
        bankLast4: { not: null },
        settlesInvoiceKey: null,
        deletedAt: null,
      },
      select: {
        id: true,
        cardLast4: true,
        valorTotal: true,
        dataPagamento: true,
        createdAt: true,
      },
    });

    const payments: Array<{ expenseId: string; payMonth: string; cardLast4: string; amount: number }> =
      candidates.map((expense) => ({
        expenseId: expense.id,
        payMonth: monthKeyOf(accountExpenseDate(expense)),
        cardLast4: expense.cardLast4 as string,
        amount: expense.valorTotal,
      }));

    const targetKey = `${dueMonth}__${card.last4}`;
    const assignments = assignImplicitPayments(invoices, payments).filter(
      (assignment) => assignment.invoiceKey === targetKey,
    );

    if (assignments.length === 0) {
      throw new NotFoundException('Nenhum pagamento encontrado para essa fatura.');
    }
    if (assignments.length > 1) {
      // Beco sem saída vira diagnóstico: devolve QUAIS pagamentos foram casados
      // (data, valor, id) pra UI mostrar — usuário reconhece "cliquei duas vezes"
      // ou "veio do import" e decide o que fazer manualmente.
      const matchedPayments = assignments.map((assignment) => {
        const candidate = candidates.find((c) => c.id === assignment.payment.expenseId);
        const date = candidate?.dataPagamento ?? candidate?.createdAt ?? null;
        return {
          id: assignment.payment.expenseId,
          amountCents: assignment.payment.amount,
          data: date ? date.toISOString() : null,
        };
      });
      throw new BadRequestException({
        message: 'Há mais de um pagamento para essa fatura — o desfazer automático não é seguro nesse caso.',
        payments: matchedPayments,
      });
    }

    const paymentExpenseId = assignments[0].payment.expenseId;

    // ARMADILHA (regra de ouro #4): `$transaction` ignora o middleware `$use`
    // de soft-delete. `tx.expense.delete(...)` seria HARD DELETE de verdade —
    // por isso o soft-delete abaixo é um `updateMany({ data: { deletedAt } })`
    // explícito, nunca `.delete()`, e com `deletedAt: null` no `where` (dentro
    // da tx o filtro do `$use` também não existe).
    const reverted = await this.prisma.$transaction(async (tx) => {
      const result = await this.cardSettlement.unsettleInvoice({
        tenantId,
        card,
        dueMonth,
        tx,
        requester,
      });
      // B1b (#448) — releitura no commit: o pagamento foi escolhido FORA da
      // transação (`assignImplicitPayments` sobre candidatos lidos antes). Um
      // `update({ where: { id } })` cru reverteria a fatura e "desfaria" um
      // pagamento que outro request já desfez no intervalo, devolvendo dois
      // sucessos para um único fato. A transição vira um UPDATE condicional
      // atômico: quem não casar com a linha AINDA viva perde e recebe 404.
      const undone = await tx.expense.updateMany({
        where: {
          id: paymentExpenseId,
          tenantId,
          projectId,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });
      if (undone.count === 0) {
        throw new NotFoundException('Nenhum pagamento encontrado para essa fatura.');
      }
      return result;
    });

    return {
      ok: true,
      undonePaymentExpenseId: paymentExpenseId,
      cardId: card.id,
      cardLast4: card.last4,
      dueMonth,
      revertedExpenses: reverted.revertedExpenses,
      revertedParcelas: reverted.revertedParcelas,
    };
  }

  async createInvoiceAdjustment(
    tenantId: string,
    projectId: string,
    dto: {
      cardLast4?: string;
      dueMonth?: string;
      amountCents?: number;
      reason?: string;
      note?: string;
    },
  ) {
    await this.ensurePessoalProject(tenantId, projectId);
    if (!dto.cardLast4) throw new BadRequestException('Cartão obrigatório.');
    const dueMonth = normalizeMonthKey(dto.dueMonth);
    if (!dto.reason) throw new BadRequestException('Motivo obrigatório.');
    if (!Number.isInteger(dto.amountCents) || dto.amountCents === 0) {
      throw new BadRequestException('Valor do ajuste inválido.');
    }

    const reason = dto.reason as InvoiceAdjustmentReasonValue;
    if (!INVOICE_ADJUSTMENT_REASONS.has(reason)) {
      throw new BadRequestException('Motivo de ajuste inválido.');
    }
    if (reason === 'QUITACAO_RESIDUO' && (dto.amountCents ?? 0) < 0) {
      throw new BadRequestException('Resíduo declarado deve ser positivo.');
    }

    // B1b (#448) — DELIBERADAMENTE sem o 409 de `last4` ambíguo que `payInvoice`
    // e `undoInvoicePayment` ganharam. Ali a duplicidade escolhe QUAL cartão
    // recebe o dinheiro; aqui a query só lê `last4` (o mesmo valor em todos os
    // empatados) e o ajuste é gravado por `cardLast4`, não por `cardId` — dois
    // cartões com o mesmo final produzem exatamente o mesmo registro. Recusar
    // aqui bloquearia uma ação legítima sem fechar brecha nenhuma. Não
    // "uniformize" isso sem antes trocar `InvoiceAdjustment.cardLast4` por uma
    // FK de identidade (#467/H4).
    const card = await this.prisma.creditCard.findFirst({
      where: { tenantId, projectId, last4: dto.cardLast4, deletedAt: null },
      select: { last4: true },
    });
    if (!card) throw new NotFoundException('Cartão não encontrado.');

    return this.prisma.invoiceAdjustment.create({
      data: {
        tenantId,
        projectId,
        cardLast4: card.last4,
        dueMonth,
        amountCents: dto.amountCents as number,
        reason,
        note: dto.note?.trim() || null,
      },
    });
  }

  async deleteInvoiceAdjustment(tenantId: string, projectId: string, id: string) {
    await this.ensurePessoalProject(tenantId, projectId);
    const row = await this.prisma.invoiceAdjustment.findFirst({
      where: { id, tenantId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Ajuste de fatura não encontrado.');
    await this.prisma.invoiceAdjustment.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Gate fail-CLOSED das mutações de dinheiro (#447 / SEC-2).
   *
   * O contrato primário é o compilador: `requester` é argumento OBRIGATÓRIO em
   * `payInvoice`/`undoInvoicePayment`. Este check cobre o chamador não tipado
   * (JS, `as any`, mock de teste) para que "esqueci o argumento" resulte em
   * recusa — nunca em acesso total silencioso, como acontecia com o requester
   * opcional (`undefined` ⇒ scope `null` ⇒ qualquer anchor PESSOAL do tenant).
   */
  private assertIdentifiedRequester(requester: MonthlyOverviewMutationRequester) {
    if (!requester?.id) {
      throw new ForbiddenException('Ação exige um usuário identificado');
    }
  }

  private async ensurePessoalProject(
    tenantId: string,
    projectId: string,
    requester?: MonthlyOverviewRequester,
  ) {
    return this.resolveAnchor(tenantId, projectId, requester);
  }
}

/** YYYY-MM em UTC (datas do banco são gravadas em UTC, sem deslocar timezone). */
function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Soma `n` meses a uma chave YYYY-MM, normalizando o ano. */
function monthKeyPlus(monthKey: string, n: number): string {
  const [year, month] = monthKey.split('-').map((value) => parseInt(value, 10));
  const d = new Date(Date.UTC(year, month - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Converte o `settlesInvoiceKey` persistido (`"{cardLast4}:{dueMonth}"`, ex.
 * `"7259:2026-06"`) na chave interna de fatura (`"{dueMonth}__{cardLast4}"`).
 * Entradas malformadas viram uma chave inerte que nunca casa com fatura real.
 */
function settlesInvoiceKeyToInternal(stored: string): string {
  const [cardLast4, dueMonth] = stored.split(':');
  if (!cardLast4 || !dueMonth) return `__invalid__${stored}`;
  return `${dueMonth}__${cardLast4}`;
}

export interface InvoiceForMatch {
  dueMonth: string;
  cardLast4: string;
  total: number;
}
export interface PaymentForMatch {
  payMonth: string;
  cardLast4: string;
  amount: number;
}
interface PaymentForMatchWithExpenseId extends PaymentForMatch {
  expenseId: string;
}

type InvoiceAdjustmentReasonValue =
  | 'JUROS_ROTATIVO'
  | 'IOF'
  | 'ESTORNO'
  | 'CONTESTACAO'
  | 'OUTRO'
  | 'QUITACAO_RESIDUO';

const INVOICE_ADJUSTMENT_REASONS = new Set<InvoiceAdjustmentReasonValue>([
  'JUROS_ROTATIVO',
  'IOF',
  'ESTORNO',
  'CONTESTACAO',
  'OUTRO',
  'QUITACAO_RESIDUO',
]);

/**
 * Agrega `CashFlowEntry` (+ `InvoiceAdjustment`) em faturas por `{dueMonth, cardLast4}`
 * — a MESMA lista que `getAccountView` usa para decidir `card.status`. Qualquer
 * consumidor que precise "quais faturas existem e quanto cada uma soma" (matching de
 * pagamento incluso) tem que passar por aqui: uma segunda montagem paralela é como o
 * bug do `undoInvoicePayment` com fatura isolada nasceu (ver `computeInvoiceTotalForCard`,
 * removido — cada card-mês tem que competir pelos mesmos pagamentos implícitos).
 */
export function buildCardInvoiceAggregates(
  entries: Array<{
    tipo: string;
    data: Date;
    valor: number;
    expense: { cardLast4: string | null; bankLast4: string | null; tipoDespesa: string } | null;
  }>,
  cards: Array<{ last4: string; nickname: string | null; closingDay: number | null; dueDay: number | null }>,
  invoiceAdjustments: Array<{ cardLast4: string; dueMonth: string; amountCents: number; reason: string }>,
): Map<string, CardInvoiceAggregate> {
  const cardByLast4 = new Map(cards.map((card) => [card.last4, card] as const));
  const invoiceByMonthCard = new Map<string, CardInvoiceAggregate>();

  for (const entry of entries) {
    if (entry.tipo !== 'DESPESA' || !entry.expense?.cardLast4) continue;
    // Neutros pagos a partir de uma CONTA (bankLast4) liquidam fatura e não entram
    // em nenhuma fatura. Mas um neutro lançado como COBRANÇA no cartão (cardLast4
    // setado, sem bankLast4) — ex.: usar este cartão para pagar a fatura de outro
    // ou "Pix no crédito" — é uma cobrança real na fatura deste cartão e espelha o
    // valor cobrado pelo banco. Continua neutro no gasto real (cash-axis/comprasCartao).
    if (isNeutralExpenseType(entry.expense.tipoDespesa) && entry.expense.bankLast4) continue;

    const card = cardByLast4.get(entry.expense.cardLast4) ?? null;
    const dueMonth = caixaMonthForCardPurchase(entry.data, card?.closingDay ?? null, card?.dueDay ?? null);
    const invoiceKey = `${dueMonth}__${entry.expense.cardLast4}`;
    let invoice = invoiceByMonthCard.get(invoiceKey);
    if (!invoice) {
      invoice = {
        dueMonth,
        cardLast4: entry.expense.cardLast4,
        nickname: card?.nickname?.trim() || `Cartao ${entry.expense.cardLast4}`,
        dueDay: card?.dueDay ?? null,
        total: 0,
        pending: 0,
        realized: 0,
        paidAmount: 0,
        residualDeclared: 0,
        adjustmentAmount: 0,
        hasManualIntervention: false,
      };
      invoiceByMonthCard.set(invoiceKey, invoice);
    }
    invoice.total += entry.valor;
  }

  const adjustmentByInvoice = new Map<string, number>();
  const hasManualInterventionByInvoice = new Set<string>();
  for (const adj of invoiceAdjustments) {
    const key = `${adj.dueMonth}__${adj.cardLast4}`;
    hasManualInterventionByInvoice.add(key);
    if (adj.reason === 'QUITACAO_RESIDUO') continue; // residual: tratado à parte pelo chamador
    adjustmentByInvoice.set(key, (adjustmentByInvoice.get(key) ?? 0) + adj.amountCents);
  }
  for (const [invoiceKey, invoice] of invoiceByMonthCard) {
    invoice.total += adjustmentByInvoice.get(invoiceKey) ?? 0;
    invoice.adjustmentAmount = adjustmentByInvoice.get(invoiceKey) ?? 0;
    invoice.hasManualIntervention = hasManualInterventionByInvoice.has(invoiceKey);
  }

  return invoiceByMonthCard;
}

/**
 * Casa pagamentos de fatura (`PAGAMENTO_FATURA_CARTAO` pagos via conta) às faturas
 * do mesmo cartão. O pagamento de uma fatura é feito no mês do vencimento OU no mês
 * anterior (faturas que vencem no dia 1 são pagas no fim do mês anterior). Por isso
 * casamos POR VALOR dentro da janela de mês `{payMonth, payMonth+1}` e só quitamos
 * quando a diferença absoluta respeita a tolerância (R$2 ou 0,5%).
 */
export function matchPaidInvoices(
  invoices: InvoiceForMatch[],
  payments: PaymentForMatch[],
): Set<string> {
  return computeInvoiceSettlementTotals(invoices, payments, []).paidInvoiceKeys;
}

function matchPaidInvoiceExpenseIds(
  invoices: InvoiceForMatch[],
  payments: PaymentForMatchWithExpenseId[],
): Map<string, string> {
  const matched = new Map<string, string>();
  const paidAmountByInvoice = computeInvoiceSettlementTotals(invoices, payments, []).paidAmountByInvoice;
  const singleByInvoice = new Map<string, string>();
  const countByInvoice = new Map<string, number>();
  const assignments = assignImplicitPayments(invoices, payments);
  for (const { payment, invoiceKey } of assignments) {
    const key = invoiceKey;
    const amount = paidAmountByInvoice.get(key) ?? 0;
    if (amount <= 0) continue;
    countByInvoice.set(key, (countByInvoice.get(key) ?? 0) + 1);
    if (!singleByInvoice.has(key)) {
      singleByInvoice.set(key, payment.expenseId);
    }
  }
  for (const [key, expenseId] of singleByInvoice) {
    if ((countByInvoice.get(key) ?? 0) === 1) matched.set(key, expenseId);
  }
  return matched;
}

interface InvoiceSettlementTotals {
  paidInvoiceKeys: Set<string>;
  paidAmountByInvoice: Map<string, number>;
}

export interface ExplicitSettlement {
  /** Chave interna da fatura alvo: `${dueMonth}__${cardLast4}`. */
  targetKey: string;
  amount: number;
}

/**
 * Conjunto de faturas quitadas, unindo dois mecanismos:
 *  - **implícito**: pagamentos via conta do PRÓPRIO cartão, casados por valor+janela
 *    (`matchPaidInvoices`) — cobre o caso comum (Nubank/5868/Latam pagos pela conta).
 *  - **explícito** (`settlesInvoiceKey`): "cartão paga cartão" e PIX direcionados à
 *    fatura de OUTRO cartão. Como há juros e pagamentos parciais, NÃO casa por valor:
 *    soma os vínculos por fatura alvo e quita quando cobrem o total. Não infla caixa —
 *    as cobranças no cartão não têm `bankLast4`.
 */
export function computePaidInvoiceKeys(
  invoices: InvoiceForMatch[],
  implicitPayments: PaymentForMatch[],
  explicitSettlements: ExplicitSettlement[],
  residualByInvoice: Map<string, number> = new Map(),
): Set<string> {
  return computeInvoiceSettlementTotals(
    invoices,
    implicitPayments,
    explicitSettlements,
    residualByInvoice,
  ).paidInvoiceKeys;
}

function computeInvoiceSettlementTotals(
  invoices: InvoiceForMatch[],
  implicitPayments: PaymentForMatch[],
  explicitSettlements: ExplicitSettlement[],
  residualByInvoice: Map<string, number> = new Map(),
): InvoiceSettlementTotals {
  const paidInvoiceKeys = new Set<string>();
  const paidAmountByInvoice = new Map<string, number>();
  const totalByKey = new Map<string, number>(
    invoices.map((invoice) => [`${invoice.dueMonth}__${invoice.cardLast4}`, invoice.total] as const),
  );

  const implicitAssignments = assignImplicitPayments(invoices, implicitPayments);
  for (const { invoiceKey, payment } of implicitAssignments) {
    const key = invoiceKey;
    paidAmountByInvoice.set(key, (paidAmountByInvoice.get(key) ?? 0) + payment.amount);
  }

  for (const settlement of explicitSettlements) {
    paidAmountByInvoice.set(
      settlement.targetKey,
      (paidAmountByInvoice.get(settlement.targetKey) ?? 0) + settlement.amount,
    );
  }

  for (const [key, total] of totalByKey) {
    const paid = paidAmountByInvoice.get(key) ?? 0;
    const tolerance = invoiceMatchTolerance(total);
    const residual = residualByInvoice.get(key) ?? 0;
    const required = Math.max(total - residual, 0);
    if (paid >= required || Math.abs(total - paid) <= tolerance) {
      paidInvoiceKeys.add(key);
    }
  }

  return { paidInvoiceKeys, paidAmountByInvoice };
}

export function assignImplicitPayments<T extends PaymentForMatch>(
  invoices: InvoiceForMatch[],
  payments: T[],
): Array<{ payment: T; invoiceKey: string }> {
  const assignments: Array<{ payment: T; invoiceKey: string }> = [];
  const paidByKey = new Map<string, number>();
  const orderedPayments = [...payments].sort(
    (a, b) => a.payMonth.localeCompare(b.payMonth) || a.amount - b.amount,
  );
  for (const payment of orderedPayments) {
    const windowMonths = [payment.payMonth, monthKeyPlus(payment.payMonth, 1)];
    const candidates = invoices.filter(
      (invoice) => invoice.cardLast4 === payment.cardLast4 && windowMonths.includes(invoice.dueMonth),
    );
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const keyA = `${a.dueMonth}__${a.cardLast4}`;
      const keyB = `${b.dueMonth}__${b.cardLast4}`;
      const remA = Math.max(a.total - (paidByKey.get(keyA) ?? 0), 0);
      const remB = Math.max(b.total - (paidByKey.get(keyB) ?? 0), 0);
      return (
        Math.abs(remA - payment.amount) - Math.abs(remB - payment.amount) ||
        a.dueMonth.localeCompare(b.dueMonth)
      );
    });
    const chosen = candidates[0];
    const invoiceKey = `${chosen.dueMonth}__${chosen.cardLast4}`;
    assignments.push({ payment, invoiceKey });
    paidByKey.set(invoiceKey, (paidByKey.get(invoiceKey) ?? 0) + payment.amount);
  }
  return assignments;
}

export interface CaixaContaAccount {
  openingBalanceCents: number;
  openingBalanceDate: Date | null;
}
export interface CaixaContaExpense {
  valorTotal: number;
  status: string;
  dataPagamento: Date | null;
  dataInicioParcela?: Date | null;
  formaPagamento?: string | null;
  quantidadeParcela?: number | null;
  paidParcelas?: string | null;
  installmentDateOverrides?: string | null;
  createdAt: Date;
}
export interface CaixaContaReceipt {
  valor: number;
  status: string;
  data: Date;
}

/**
 * Reconciliação §10 (função pura, testável): saldo da conta hoje =
 * saldo inicial + Σ lançamentos REALIZADOS da conta. Espera apenas lançamentos
 * com `bankLast4` (filtrados pelo chamador). Parcelados usam o status do root ou
 * `paidParcelas`; cartão (sem bankLast4) e ocorrências futuras ficam de fora.
 *
 * CORTE PELO SALDO INICIAL: um saldo inicial datado JÁ EMBUTE tudo que aconteceu
 * até ali — somar lançamentos anteriores a ele conta o mesmo dinheiro duas vezes.
 * Antes deste corte, `openingBalanceDate` era lido do banco e usado apenas para o
 * booleano `temSaldoInicial`, nunca para filtrar (dupla contagem de R$ 5.489,44
 * medida em produção: 3 recebimentos de nov/dez-2025 somados sobre um saldo
 * inicial de 31/12/2025).
 *
 * Semântica: "saldo inicial em D" = saldo na ABERTURA de D, então lançamentos
 * do próprio dia D contam; só os ESTRITAMENTE anteriores são descartados.
 *
 * CORTE POR "HOJE" (`today`, no fuso FINANCIAL_TIME_ZONE): "caixa hoje" é saldo
 * REALIZADO, então uma ocorrência só entra se a data dela já chegou (data <= hoje).
 * Antes deste corte, um PARCELADO/QUINZENAL com `status:'PAGO'` no root distribuía
 * TODAS as parcelas — inclusive as futuras, sem movimento no extrato — drenando o
 * caixa (repro do PO: R$3.600 em 6× com só a 1ª debitada caía R$3.600 em vez de
 * R$600; série quinzenal de mão de obra da REFORMA drenava milhares). Idem para
 * despesa simples PAGO e recebimento EM_CAIXA datados no futuro. `paidParcelas` é
 * evidência explícita por-parcela (pré-pagamento manual) e NÃO é cortada por hoje —
 * só a propagação fraca do `status` do root é. O corte se aplica a `movs`, então
 * afeta `hoje` E `porMes` de forma consistente: o histórico passado permanece no
 * sparkline e só as ocorrências futuras somem (nada é inventado no futuro).
 *
 * ponytail: usa a âncora mais antiga entre as contas — espelha a premissa de
 * conta única já assumida por `pickPrimaryBankAccount`. Com duas contas ancoradas
 * em datas diferentes, promover a corte por conta (exige atribuir cada lançamento
 * à sua conta, hoje ambíguo quando dois BankAccount compartilham o mesmo last4).
 */
export function computeCaixaConta(
  accounts: CaixaContaAccount[],
  expenses: CaixaContaExpense[],
  receipts: CaixaContaReceipt[],
  today: Date = todayLocalDateUtc(FINANCIAL_TIME_ZONE),
) {
  const saldoInicial = accounts.reduce((s, a) => s + a.openingBalanceCents, 0);
  const temSaldoInicial = accounts.some(
    (a) => a.openingBalanceCents !== 0 || a.openingBalanceDate != null,
  );

  const cutoff = accounts.reduce<Date | null>((earliest, a) => {
    if (!a.openingBalanceDate) return earliest;
    if (!earliest) return a.openingBalanceDate;
    return a.openingBalanceDate < earliest ? a.openingBalanceDate : earliest;
  }, null);
  const beforeOpening = (d: Date | null | undefined) =>
    !!cutoff && !!d && d.getTime() < cutoff.getTime();

  // CORTE POR "HOJE" (§10 = saldo REALIZADO): uma ocorrência só entra no caixa se a data
  // dela já chegou. Antes deste corte, uma despesa PARCELADO/QUINZENAL com `status:'PAGO'`
  // no root distribuía TODAS as parcelas — inclusive as futuras, sem movimento no extrato —
  // drenando o caixa por dinheiro que ainda não saiu (medido em prod: série quinzenal de
  // mão de obra da REFORMA). O mesmo valia para despesa simples PAGO e recebimento EM_CAIXA
  // com data futura. `paidParcelas` é evidência explícita por-parcela (pré-pagamento manual)
  // e continua contando mesmo datada no futuro; o corte atinge só a propagação fraca do root.
  const afterToday = (d: Date | null | undefined) =>
    !!d && d.getTime() > today.getTime();

  // Lançamentos realizados com sinal (despesa −, recebimento +) e mês de referência.
  const movs: Array<{ mes: string; valor: number }> = [];
  for (const e of expenses) {
    if (
      e.formaPagamento === PaymentForm.PARCELADO ||
      e.formaPagamento === PaymentForm.QUINZENAL
    ) {
      const installments = buildInstallments({
        valorTotal: e.valorTotal,
        formaPagamento: e.formaPagamento,
        quantidadeParcela: e.quantidadeParcela,
        dataInicioParcela: e.dataInicioParcela ?? e.dataPagamento ?? e.createdAt,
        dataPagamento: e.dataPagamento,
        installmentDateOverrides: e.installmentDateOverrides,
      });
      const paidParcelas = new Set(
        parsePaidParcelas(e.paidParcelas, installments.length),
      );
      installments.forEach((installment, index) => {
        const paid = paidParcelas.has(index);
        if (!paid) {
          if (e.status !== 'PAGO') return; // não realizado
          if (afterToday(installment.data)) return; // root PAGO não realiza futuro sem evidência
        }
        if (beforeOpening(installment.data)) return;
        movs.push({ mes: monthKeyOf(installment.data), valor: -installment.valor });
      });
      continue;
    }
    if (e.status !== 'PAGO') continue; // só realizados afetam o caixa
    const d = e.dataPagamento ?? e.createdAt;
    if (afterToday(d)) continue; // PAGO com data futura ainda não saiu do banco
    if (beforeOpening(d)) continue;
    movs.push({ mes: monthKeyOf(d), valor: -e.valorTotal });
  }
  for (const r of receipts) {
    if (r.status !== 'EM_CAIXA') continue;
    if (afterToday(r.data)) continue; // EM_CAIXA com data futura ainda não creditou
    if (beforeOpening(r.data)) continue;
    movs.push({ mes: monthKeyOf(r.data), valor: r.valor });
  }

  const netRealizado = movs.reduce((s, m) => s + m.valor, 0);

  // Série mensal acumulada (saldo ao fim de cada mês) para o sparkline.
  const porMesMap = new Map<string, number>();
  for (const m of movs) porMesMap.set(m.mes, (porMesMap.get(m.mes) ?? 0) + m.valor);
  const porMes: Array<{ mes: string; caixa: number }> = [];
  let acc = saldoInicial;
  for (const mes of Array.from(porMesMap.keys()).sort()) {
    acc += porMesMap.get(mes) ?? 0;
    porMes.push({ mes, caixa: acc });
  }

  return { hoje: saldoInicial + netRealizado, saldoInicial, temSaldoInicial, porMes };
}

interface CardInvoiceAggregate {
  dueMonth: string;
  cardLast4: string;
  nickname: string;
  dueDay: number | null;
  total: number;
  pending: number;
  realized: number;
  paidAmount: number;
  residualDeclared: number;
  adjustmentAmount: number;
  hasManualIntervention: boolean;
}

interface DreLine {
  kind: 'entrada' | 'saida';
  valor: number;
  mesCompetencia: string;
  mesConta: string;
  realizado: boolean;
  label: string;
  sourceLabel?: string;
  sourceIcon?: string;
  group?: string;
  icon?: string;
  color?: string;
  isGuardado?: boolean;
  cardLast4?: string | null;
}

interface DreSimpleLine {
  label: string;
  valor: number;
  icon?: string;
}

interface DreAnnualTotal {
  label: string;
  icon: string;
  color: string;
  total: number;
  mediaMensal: number;
}

function dreExpenseMeta(tipoDespesa: string): {
  group: string;
  icon: string;
  color: string;
  isGuardado: boolean;
} {
  if (tipoDespesa === 'INVESTIMENTOS') {
    return { group: 'Investimentos', icon: 'piggy-bank', color: '#BA7517', isGuardado: true };
  }
  // Pagamento Casa: neutro DE CONSUMO (aporte para o lar) — como o investimento,
  // sai do consumo/resultado/média/categorias e vai para o bucket "guardado"
  // (dinheiro que saiu do caixa mas não é gasto). Mantém paridade com o cockpit
  // anual (entryIsConsumptionNeutral).
  if (tipoDespesa === 'PAGAMENTO_CASA') {
    return { group: 'Pagamento Casa', icon: 'home', color: '#BA7517', isGuardado: true };
  }
  if (
    ['MORADIA', 'CONTAS_UTILIDADES', 'TELEFONE_INTERNET', 'PAGAMENTO_BOLETO'].includes(
      tipoDespesa,
    )
  ) {
    return { group: 'Moradia', icon: 'home', color: '#D85A30', isGuardado: false };
  }
  if (['ALIMENTACAO', 'SUPERMERCADO'].includes(tipoDespesa)) {
    return { group: 'Alimentação', icon: 'utensils', color: '#D85A30', isGuardado: false };
  }
  if (
    ['TRANSPORTE', 'GASOLINA', 'ESTACIONAMENTO', 'LAVAGEM', 'PIX_ENVIADO', 'TRANSFERENCIA_TED'].includes(
      tipoDespesa,
    )
  ) {
    return { group: 'Transporte', icon: 'car', color: '#D85A30', isGuardado: false };
  }
  if (['SAUDE', 'REEMBOLSO_MEDICO', 'SEGUROS_PESSOAIS'].includes(tipoDespesa)) {
    return { group: 'Saúde', icon: 'heart', color: '#D85A30', isGuardado: false };
  }
  if (['LAZER', 'BELEZA', 'PETS', 'ASSINATURAS'].includes(tipoDespesa)) {
    return { group: 'Lazer & estilo', icon: 'sparkles', color: '#D85A30', isGuardado: false };
  }
  if (tipoDespesa === 'EDUCACAO') {
    return { group: 'Educação', icon: 'school', color: '#D85A30', isGuardado: false };
  }
  if (
    ['IMPOSTO', 'IMPOSTOS_IOF', 'IMPOSTOS_TAXAS', 'TARIFAS_BANCARIAS', 'CARTAO_CREDITO'].includes(
      tipoDespesa,
    )
  ) {
    return { group: 'Financeiro', icon: 'coins', color: '#D85A30', isGuardado: false };
  }
  return { group: 'Outros', icon: 'coins', color: '#D85A30', isGuardado: false };
}

function receiptSourceLabel(tipo?: string | null): string {
  const t = (tipo ?? 'OUTROS').toUpperCase();
  if (['SALARIO', 'ADIANTAMENTO_SALARIO', 'DECIMO_TERCEIRO', 'FERIAS'].includes(t)) {
    return 'Salário';
  }
  if (['REEMBOLSO', 'PIX_RECEBIDO'].includes(t)) return 'Reembolso';
  if (['DIVIDENDOS', 'JUROS_RENDA_FIXA', 'POUPANCA', 'ACAO', 'FII', 'CRIPTO'].includes(t)) {
    return 'Renda variável';
  }
  if (['FREELANCE', 'COMISSAO', 'BONUS'].includes(t)) return 'Trabalho extra';
  return receiptTypeLabel(t);
}

function receiptSourceIcon(source: string): string {
  if (source === 'Salário') return 'wallet';
  if (source === 'Reembolso') return 'refresh';
  if (source === 'Renda variável') return 'chart-line';
  if (source === 'Trabalho extra') return 'briefcase';
  return 'wallet';
}

function groupSimpleLines(
  lines: DreLine[],
  keyBy: (line: DreLine) => string,
  metaBy: (line: DreLine) => { label: string; icon?: string },
): DreSimpleLine[] {
  const map = new Map<string, DreSimpleLine>();
  for (const line of lines) {
    const key = keyBy(line);
    const meta = metaBy(line);
    const current = map.get(key);
    if (!current) {
      map.set(key, { label: meta.label, valor: line.valor, icon: meta.icon });
      continue;
    }
    current.valor += line.valor;
  }
  return Array.from(map.values()).sort((a, b) => b.valor - a.valor);
}

function groupLabelValues(
  lines: Array<{ label: string; valor: number }>,
): Array<{ label: string; valor: number }> {
  const map = new Map<string, number>();
  for (const line of lines) {
    map.set(line.label, (map.get(line.label) ?? 0) + line.valor);
  }
  return Array.from(map.entries())
    .map(([label, valor]) => ({ label, valor }))
    .sort((a, b) => b.valor - a.valor);
}

function groupDreGroups(lines: DreLine[]): Array<{
  group: string;
  icon: string;
  color: string;
  items: Array<{ label: string; valor: number }>;
}> {
  const groupMap = new Map<
    string,
    {
      group: string;
      icon: string;
      color: string;
      itemsMap: Map<string, number>;
    }
  >();

  for (const line of lines) {
    const group = line.group ?? 'Outros';
    const itemLabel = line.label || group;
    const current = groupMap.get(group);
    if (!current) {
      const itemsMap = new Map<string, number>();
      itemsMap.set(itemLabel, line.valor);
      groupMap.set(group, {
        group,
        icon: line.icon ?? 'coins',
        color: line.color ?? '#D85A30',
        itemsMap,
      });
      continue;
    }
    current.itemsMap.set(itemLabel, (current.itemsMap.get(itemLabel) ?? 0) + line.valor);
  }

  return Array.from(groupMap.values())
    .map((group) => ({
      group: group.group,
      icon: group.icon,
      color: group.color,
      items: Array.from(group.itemsMap.entries())
        .map(([label, valor]) => ({ label, valor }))
        .sort((a, b) => b.valor - a.valor),
    }))
    .sort(
      (a, b) =>
        sumBy(b.items, (item) => item.valor) - sumBy(a.items, (item) => item.valor),
    );
}

function groupAnnualTotals(
  lines: DreLine[],
  keyBy: (line: DreLine) => string,
  metaBy: (line: DreLine) => { label: string; icon: string; color: string },
  monthsBase: number,
): DreAnnualTotal[] {
  const map = new Map<string, DreAnnualTotal>();
  for (const line of lines) {
    const key = keyBy(line);
    const meta = metaBy(line);
    const current = map.get(key);
    if (!current) {
      map.set(key, {
        label: meta.label,
        icon: meta.icon,
        color: meta.color,
        total: line.valor,
        mediaMensal: Math.round(line.valor / monthsBase),
      });
      continue;
    }
    current.total += line.valor;
    current.mediaMensal = Math.round(current.total / monthsBase);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function dreMonthResult(lines: DreLine[], mes: string): number {
  const entrou = sumBy(
    lines.filter(
      (line) =>
        line.kind === 'entrada' && line.realizado && line.mesCompetencia === mes,
    ),
    (line) => line.valor,
  );
  const saiu = sumBy(
    lines.filter(
      (line) =>
        line.kind === 'saida' &&
        line.realizado &&
        !line.isGuardado &&
        line.mesCompetencia === mes,
    ),
    (line) => line.valor,
  );
  // Guardado (investimento) é memo, não reduz o resultado — coerente com o cockpit.
  return entrou - saiu;
}

function monthNumber(mes: string): number {
  return parseInt(mes.split('-')[1] ?? '1', 10);
}

function monthShortLabel(monthNumberValue: number): string {
  const date = new Date(Date.UTC(2026, Math.max(1, Math.min(12, monthNumberValue)) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' })
    .format(date)
    .replace('.', '');
}

function normalizeMonthKey(month?: string): string {
  if (!month) {
    const now = todayLocalDateUtc(FINANCIAL_TIME_ZONE);
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new BadRequestException('Mês inválido. Use o formato YYYY-MM.');
  }
  const [year, monthNumber] = month.split('-').map((value) => parseInt(value, 10));
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) {
    throw new BadRequestException('Mês inválido. Use o formato YYYY-MM.');
  }
  return `${year}-${String(monthNumber).padStart(2, '0')}`;
}

function normalizeYear(year?: string | number): number {
  if (year === undefined || year === null || year === '') {
    return todayLocalDateUtc(FINANCIAL_TIME_ZONE).getUTCFullYear();
  }
  const parsed = typeof year === 'number' ? year : parseInt(year, 10);
  if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 2100) {
    throw new BadRequestException('Ano inválido. Use o formato YYYY (2000–2100).');
  }
  return parsed;
}

function monthRange(monthKey: string): [Date, Date] {
  const [year, month] = monthKey.split('-').map((value) => parseInt(value, 10));
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return [start, end];
}

function lastMonthKeys(endMonthKey: string, count: number): string[] {
  const [year, month] = endMonthKey.split('-').map((value) => parseInt(value, 10));
  return Array.from({ length: count }, (_, index) => {
    const current = new Date(Date.UTC(year, month - count + index, 1));
    return `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

function isInRange(date: Date, start: Date, end: Date): boolean {
  return date >= start && date < end;
}

function purchaseDate(expense: {
  dataPagamento: Date | null;
  dataInicioParcela: Date | null;
  createdAt: Date;
}): Date {
  return (
    expense.dataPagamento
    ?? expense.dataInicioParcela
    ?? todayLocalDateUtc(FINANCIAL_TIME_ZONE, expense.createdAt)
  );
}

/**
 * A despesa DECLAROU uma data para o dinheiro sair (`dataPagamento` ou
 * `dataInicioParcela`)? Sem nenhuma delas, `purchaseDate` cai no `createdAt`,
 * que é carimbo de DIGITAÇÃO e não promessa de pagamento futuro — logo não pode
 * arbitrar um corte de caixa: quem decide é o `status='PAGO'`.
 *
 * Com data declarada o corte VALE mesmo em pagamento único PAGO: "paguei, com
 * data futura" é pagamento agendado, o dinheiro ainda não saiu da carteira.
 */
function hasDeclaredDate(expense: {
  dataPagamento: Date | null;
  dataInicioParcela: Date | null;
}): boolean {
  return expense.dataPagamento != null || expense.dataInicioParcela != null;
}

/**
 * PONTO ÚNICO do corte "hoje" do saldo pontual da Carteira (#560) — todo
 * chamador passa por aqui; NUNCA replicar o gate por chamador (foi a réplica
 * divergente que produziu a regressão consertada nesta issue).
 *
 * Uma ocorrência entra no caixa de hoje se está realizada E (a) sua data já
 * chegou ou (b) o pagamento é EXPLÍCITO. "Explícito" = evidência direta de que
 * o dinheiro JÁ saiu, e nesse caso a data não manda:
 *
 *  - parcela em `paidParcelas` (pré-pagamento manual, evidência por-parcela);
 *  - pagamento único PAGO que não DECLAROU data (ver `hasDeclaredDate`).
 *
 * Espelha exatamente `computeCaixaConta` (motor §10 congelado), que já isenta
 * `paidParcelas` do corte — critério de aceite nº 1 da #560: `carteiraTotal`
 * idêntica ao §10. Duas fórmulas para o mesmo dinheiro é a classe de bug da
 * #508; se um dos lados mudar, o outro muda junto.
 *
 * NÃO é explícito o `realizado` herdado do `status='PAGO'` da despesa
 * PARCELADA/QUINZENAL: essa propagação fraca marca TODAS as parcelas, inclusive
 * futuras sem movimento no extrato, e continua sujeita a `data <= today` — era
 * o bug original da #560 (R$3.600 em 6× drenando o caixa inteiro).
 */
function countsInCarteiraToday(occurrence: CarteiraOccurrence, today: Date): boolean {
  return occurrence.realizado && (occurrence.explicitlyPaid || occurrence.data <= today);
}

function accountExpenseDate(expense: { dataPagamento: Date | null; createdAt: Date }): Date {
  return expense.dataPagamento ?? todayLocalDateUtc(FINANCIAL_TIME_ZONE, expense.createdAt);
}

function dueDateIso(monthKey: string, dueDay: number | null): string {
  const [year, month] = monthKey.split('-').map((value) => parseInt(value, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = dueDay == null ? 1 : Math.min(Math.max(dueDay, 1), lastDay);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function expenseDisplayName(
  tipoDespesa: string,
  titulo: string | null,
  fornecedor: string | null,
): string {
  return titulo?.trim() || fornecedor?.trim() || ExpenseTypeLabels[tipoDespesa as keyof typeof ExpenseTypeLabels] || tipoDespesa;
}

function inferCashForm(rawText: string, formaPagamento: string | null): 'pix' | 'debito' | 'boleto' | 'ted' {
  const text = rawText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (/\bPIX\b/.test(text)) return 'pix';
  if (/\bTED\b|\bDOC\b/.test(text)) return 'ted';
  if (/\bBOLETO\b|\bCODIGO DE BARRAS\b|\bBARCODE\b/.test(text)) return 'boleto';
  if (formaPagamento === 'CONTA_CORRENTE') return 'debito';
  return 'debito';
}

function receiptTypeKey(tipo: string): string {
  const normalized = tipo.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return normalized.toLowerCase();
}

function receiptTypeLabel(tipo: string): string {
  const labels: Record<string, string> = {
    SALARIO: 'Salario',
    ADIANTAMENTO_SALARIO: 'Adiantamento',
    DECIMO_TERCEIRO: '13 salario',
    FERIAS: 'Ferias',
    FREELANCE: 'Freelance',
    ALUGUEL: 'Aluguel',
    REEMBOLSO: 'Reembolso',
    DIVIDENDOS: 'Dividendos',
    JUROS_RENDA_FIXA: 'Rendimento',
    RESGATE: 'Resgate',
    RESTITUICAO_IR: 'Restituicao IR',
    BONUS: 'Bonus',
    COMISSAO: 'Comissao',
    OUTROS: 'Outros',
  };
  return labels[tipo] ?? tipo.replace(/_/g, ' ');
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

/** Candidato para a sheet "Como fechar no azul?" */
export interface RunwayCandidato {
  expenseId: string;
  descricao: string;
  /** Soma dos valores (centavos) para essa despesa na janela até o crossover. */
  valor: number;
  /** ISO string da ocorrência mais próxima (para referência de timing). */
  data: string;
  projetoOrigem: { id: string; name: string; type: string } | null;
}

/**
 * Seleciona os até 5 maiores gastos PLANEJADOS entre `mesSelecionado` e o
 * primeiro mês com `saldoProjetado < 0` (crossover), usando as saidas já
 * calculadas por `getAccountView` — NUNCA um segundo motor.
 *
 * Exclusões (regra de ouro §W4):
 *  - `isInvoice: true`  (fatura agregada — não é despesa editável)
 *  - `realizado: true`  (já pago/quitado)
 *  - espelhos: itens com `projetoOrigem != null && foreignExpenseId == null`
 *    (PESSOAL expense com linkedExpenseId — o foreign pending já o representa)
 *
 * Deduplicação: mesma despesa (mesmo expenseId) pode aparecer em meses
 * diferentes (parcelas); soma-se o valor e guarda-se a data mais próxima.
 */
export function buildRunwayCandidatos(
  saldoAcumuladoSerie: Array<{ mes: string; saldoProjetado: number }>,
  monthlyViews: Array<{ saidas: Array<any> }>,
  months: string[],
  mesSelecionado: string,
): RunwayCandidato[] {
  // Encontra o primeiro mês a partir do selecionado com saldo projetado negativo.
  const crossoverMes = saldoAcumuladoSerie.find(
    (row) => row.mes >= mesSelecionado && row.saldoProjetado < 0,
  )?.mes ?? null;
  if (!crossoverMes) return [];

  // Acumula por expenseId: valor total da janela + data mais próxima.
  const byId = new Map<string, { descricao: string; valor: number; data: string; projetoOrigem: RunwayCandidato['projetoOrigem'] }>();

  for (let i = 0; i < months.length; i++) {
    const mes = months[i];
    if (mes < mesSelecionado || mes > crossoverMes) continue;
    const view = monthlyViews[i];
    if (!view) continue;

    for (const item of (view.saidas ?? []) as Array<any>) {
      if (item.isInvoice) continue;
      if (item.realizado) continue;
      if (isConsumptionNeutralExpenseType(item.tipoDespesa)) continue;
      // Exclui espelhos PESSOAL (linkedExpenseId != null → projetoOrigem set, foreignExpenseId null)
      if (item.projetoOrigem !== null && item.projetoOrigem !== undefined && !item.foreignExpenseId) continue;

      const id: string | null = item.foreignExpenseId ?? item.id;
      if (!id) continue;

      const existing = byId.get(id);
      if (existing) {
        existing.valor += item.valor as number;
        if ((item.data as string) < existing.data) existing.data = item.data;
      } else {
        byId.set(id, {
          descricao: item.descricao,
          valor: item.valor,
          data: item.data,
          projetoOrigem: item.projetoOrigem ?? null,
        });
      }
    }
  }

  return Array.from(byId.entries())
    .sort((a, b) => b[1].valor - a[1].valor)
    .slice(0, 5)
    .map(([expenseId, v]) => ({ expenseId, ...v }));
}
