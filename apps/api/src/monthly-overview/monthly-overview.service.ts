import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import {
  buildMonthlyOverview,
  caixaMonthForCardPurchase,
  compareMonths,
  ExpenseTypeLabels,
  isNeutralExpenseType,
  type MonthlyOverviewEntry,
} from '@reformaflow/domain';

@Injectable()
export class MonthlyOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cardSettlement: CardInvoiceSettlementService,
  ) {}

  async getOverview(tenantId: string, pessoalProjectId: string) {
    const pessoal = await this.prisma.project.findFirst({
      where: { id: pessoalProjectId, tenantId, deletedAt: null },
    });
    if (!pessoal) throw new NotFoundException('Projeto não encontrado');
    if (pessoal.type !== 'PESSOAL') {
      throw new BadRequestException(
        'Visão consolidada disponível apenas para projetos do tipo PESSOAL',
      );
    }

    // Todos os projetos não-deletados do tenant (PESSOAL + REFORMA + CASA + CARRO + ...)
    const projects = await this.prisma.project.findMany({
      where: { tenantId, deletedAt: null },
    });
    const projectIds = projects.map((p) => p.id);
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
      include: { expense: { select: { linkedExpenseId: true, cardLast4: true } } },
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

    const today = new Date();
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
      subcategoria: e.subcategoria,
      parcela: e.parcela,
      formaPagamento: e.formaPagamento,
      projectId: e.projectId,
      projectName: projectNameById.get(e.projectId) ?? '',
      projectType: projectTypeById.get(e.projectId) ?? 'OUTROS',
      cardLast4: e.expense?.cardLast4 ?? null,
      isEspelho: isEspelho(e),
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

    const caixa = await this.computeCaixaConta(tenantId, pessoalProjectId);

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
      caixa,
      cards,
    };
  }

  async getAccountView(tenantId: string, projectId: string, month?: string) {
    await this.ensurePessoalProject(tenantId, projectId);

    const mesSelecionado = normalizeMonthKey(month);
    const [monthStart, monthEnd] = monthRange(mesSelecionado);
    const sixMonthKeys = lastMonthKeys(mesSelecionado, 6);
    const sixMonthSet = new Set(sixMonthKeys);
    const today = new Date();

    const [accounts, expenses, receipts, entries, cards] = await Promise.all([
      this.prisma.bankAccount.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: {
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
          tipoDespesa: true,
          titulo: true,
          fornecedor: true,
          valor: true,
          valorTotal: true,
          formaPagamento: true,
          dataPagamento: true,
          dataInicioParcela: true,
          quantidadeParcela: true,
          status: true,
          cardLast4: true,
          bankLast4: true,
          createdAt: true,
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
          nickname: true,
          last4: true,
          closingDay: true,
          dueDay: true,
          limitTotalCents: true,
          limitAvailableCents: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const caixa = computeCaixaConta(
      accounts,
      expenses.filter((expense) => !!expense.bankLast4),
      receipts.filter((receipt) => !!receipt.bankLast4),
    );

    const entrouMes = sumBy(
      receipts.filter(
        (receipt) =>
          !!receipt.bankLast4 &&
          receipt.status === 'EM_CAIXA' &&
          receipt.data >= monthStart &&
          receipt.data < monthEnd,
      ),
      (receipt) => receipt.valor,
    );

    const recebimentosPrevistosMes = sumBy(
      receipts.filter(
        (receipt) =>
          !!receipt.bankLast4 &&
          receipt.status === 'PREVISTO' &&
          receipt.data >= monthStart &&
          receipt.data < monthEnd,
      ),
      (receipt) => receipt.valor,
    );

    const saiuMes = sumBy(
      expenses.filter(
        (expense) =>
          !!expense.bankLast4 &&
          expense.status === 'PAGO' &&
          isInRange(accountExpenseDate(expense), monthStart, monthEnd),
      ),
      (expense) => expense.valorTotal,
    );

    const cardByLast4 = new Map(cards.map((card) => [card.last4, card] as const));
    const paidInvoiceKeys = new Set(
      expenses
        .filter(
          (expense) =>
            expense.tipoDespesa === 'PAGAMENTO_FATURA_CARTAO' &&
            expense.status === 'PAGO' &&
            !!expense.bankLast4 &&
            !!expense.cardLast4,
        )
        .map((expense) => `${monthKeyOf(accountExpenseDate(expense))}__${expense.cardLast4}`),
    );
    const invoiceByMonthCard = new Map<string, CardInvoiceAggregate>();

    for (const entry of entries) {
      if (entry.tipo !== 'DESPESA' || !entry.expense?.cardLast4) continue;
      if (isNeutralExpenseType(entry.expense.tipoDespesa)) continue;

      const card = cardByLast4.get(entry.expense.cardLast4) ?? null;
      const dueMonth = caixaMonthForCardPurchase(
        entry.data,
        card?.closingDay ?? null,
        card?.dueDay ?? null,
      );
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
        };
        invoiceByMonthCard.set(invoiceKey, invoice);
      }

      invoice.total += entry.valor;
    }

    for (const [invoiceKey, invoice] of invoiceByMonthCard) {
      if (paidInvoiceKeys.has(invoiceKey)) {
        invoice.realized = invoice.total;
        invoice.pending = 0;
      } else {
        invoice.realized = 0;
        invoice.pending = invoice.total;
      }
    }

    const invoiceRows = Array.from(invoiceByMonthCard.values());
    const selectedInvoices = invoiceRows
      .filter((invoice) => invoice.dueMonth === mesSelecionado)
      .sort((a, b) => b.total - a.total);

    const accountExpenseEntries = entries
      .filter((entry) => {
        if (entry.tipo !== 'DESPESA' || !entry.expense?.bankLast4 || entry.expense.cardLast4) return false;
        if (isNeutralExpenseType(entry.expense.tipoDespesa)) return false;
        return isInRange(entry.data, monthStart, monthEnd);
      })
      .sort((a, b) => a.data.getTime() - b.data.getTime());

    const faltaPagarMes =
      sumBy(selectedInvoices, (invoice) => invoice.pending) +
      sumBy(
        accountExpenseEntries.filter((entry) => entry.status !== 'PAGO'),
        (entry) => entry.valor,
      );

    const saidas = [
      ...selectedInvoices.map((invoice) => ({
        id: null as string | null,
        kind: 'saida' as const,
        descricao: `Fatura ${invoice.nickname}`,
        data: dueDateIso(mesSelecionado, invoice.dueDay),
        forma: 'cartao',
        valor: invoice.total,
        realizado: invoice.pending === 0,
        status: invoice.pending === 0 ? 'PAGO' : 'PLANEJADO',
        cardLast4: invoice.cardLast4,
        bankLast4: null as string | null,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        isInvoice: true,
        editavel: false,
        dueMonth: invoice.dueMonth,
      })),
      ...accountExpenseEntries.map((entry) => {
        const expense = entry.expense!;
        return {
          id: expense.id as string | null,
          kind: 'saida' as const,
          descricao: expenseDisplayName(expense.tipoDespesa, expense.titulo, expense.fornecedor),
          data: entry.data.toISOString(),
          forma: inferCashForm(
            `${expense.titulo ?? ''} ${expense.fornecedor ?? ''} ${entry.subcategoria ?? ''}`,
            entry.formaPagamento,
          ),
          valor: entry.valor,
          realizado: entry.status === 'PAGO',
          status: entry.status,
          cardLast4: null as string | null,
          bankLast4: expense.bankLast4,
          tipoDespesa: expense.tipoDespesa,
          isInvoice: false,
          editavel: true,
          dueMonth: null as string | null,
        };
      }),
    ].sort((a, b) => b.data.localeCompare(a.data));

    const entradas = receipts
      .filter(
        (receipt) =>
          !!receipt.bankLast4 &&
          receipt.status === 'EM_CAIXA' &&
          receipt.data >= monthStart &&
          receipt.data < monthEnd,
      )
      .sort((a, b) => b.data.getTime() - a.data.getTime())
      .map((receipt) => ({
        id: receipt.id as string | null,
        kind: 'entrada' as const,
        descricao: receipt.descricao?.trim() || receiptTypeLabel(receipt.tipo),
        data: receipt.data.toISOString(),
        tipo: receiptTypeKey(receipt.tipo),
        valor: receipt.valor,
        bankLast4: receipt.bankLast4,
        status: 'EM_CAIXA',
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
      const openInvoiceMonth = currentOpenInvoiceMonth(card, today);
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
        } satisfies CardInvoiceAggregate);
      const canShowLimit =
        card.limitTotalCents != null && card.limitAvailableCents != null && card.limitTotalCents > 0;
      const limitTotal = canShowLimit ? card.limitTotalCents! : null;
      const limitAvailable = canShowLimit ? card.limitAvailableCents! : null;
      const limiteUsado = canShowLimit
        ? Math.max(limitTotal! - limitAvailable!, 0)
        : null;
      return {
        nickname: card.nickname?.trim() || 'Cartao',
        last4: card.last4,
        faturaAtual: invoice.total,
        faturaPendente: invoice.pending,
        dueMonth: openInvoiceMonth,
        vencimento: dueDateIso(openInvoiceMonth, card.dueDay),
        status: invoice.pending > 0 ? 'a pagar' : 'paga',
        limiteUsadoPct:
          canShowLimit && limiteUsado != null
            ? Math.round((limiteUsado / limitTotal!) * 100)
            : null,
        limiteUsado,
        limiteTotal: limitTotal,
      };
    });

    const contas = accounts
      .filter((account) => !!account.last4)
      .map((account) => ({
        last4: account.last4,
        nome: account.nickname?.trim() || account.institution || `Conta ${account.last4}`,
      }));

    return {
      mesSelecionado,
      caixaHoje: caixa.hoje,
      entrouMes,
      saiuMes,
      faltaPagarMes,
      sobraPrevista: caixa.hoje - faltaPagarMes + recebimentosPrevistosMes,
      devoCartaoTotal,
      cartoes,
      contas,
      saidas,
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

  /**
   * Caixa real da conta corrente — reconciliação §10 do consolidado financeiro:
   *
   *   saldo hoje = saldo inicial (das contas) + Σ lançamentos REALIZADOS da conta
   *
   * "Lançamento da conta" = qualquer Expense/Receipt com `bankLast4` preenchido
   * (extrato, aplicações/resgates e pagamentos de fatura debitados na conta).
   * Itens de cartão (cardLast4, sem bankLast4) NÃO entram — eles estão na fatura,
   * não na conta. Lançamentos futuros (PLANEJADO, ex.: seguros agendados) ficam de
   * fora porque ainda não foram debitados — exatamente o que a §10 manda descontar.
   *
   * Diferente de "caixaAgora" do cockpit (fluxo realizado conta+cartão): este bate
   * com o saldo do app do banco quando o saldo inicial está cadastrado.
   */
  private async computeCaixaConta(tenantId: string, projectId: string) {
    const [accounts, expenses, receipts] = await Promise.all([
      this.prisma.bankAccount.findMany({
        where: { tenantId, projectId, deletedAt: null },
        select: { openingBalanceCents: true, openingBalanceDate: true },
      }),
      this.prisma.expense.findMany({
        where: { tenantId, projectId, deletedAt: null, bankLast4: { not: null } },
        select: { valorTotal: true, status: true, dataPagamento: true, createdAt: true },
      }),
      this.prisma.receipt.findMany({
        where: { tenantId, projectId, deletedAt: null, bankLast4: { not: null } },
        select: { valor: true, status: true, data: true },
      }),
    ]);
    return computeCaixaConta(accounts, expenses, receipts);
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
   */
  async payInvoice(
    tenantId: string,
    projectId: string,
    dto: {
      cardLast4?: string;
      month?: string;
      amountCents?: number;
      bankLast4?: string;
      paymentDate?: string;
    },
  ) {
    await this.ensurePessoalProject(tenantId, projectId);

    const month = normalizeMonthKey(dto.month);
    if (!dto.cardLast4) throw new BadRequestException('Cartão obrigatório.');
    if (!dto.bankLast4) throw new BadRequestException('Conta de débito obrigatória.');
    if (!Number.isInteger(dto.amountCents) || (dto.amountCents ?? 0) <= 0) {
      throw new BadRequestException('Valor da fatura inválido.');
    }
    const amountCents = dto.amountCents as number;

    const card = await this.prisma.creditCard.findFirst({
      where: { tenantId, projectId, last4: dto.cardLast4, deletedAt: null },
      select: { id: true, last4: true, nickname: true, closingDay: true, dueDay: true },
    });
    if (!card) throw new NotFoundException('Cartão não encontrado.');

    const account = await this.prisma.bankAccount.findFirst({
      where: { tenantId, projectId, last4: dto.bankLast4, deletedAt: null },
      select: { last4: true },
    });
    if (!account) throw new NotFoundException('Conta de débito não encontrada.');

    // Já paga neste mês? (mesma chave do getAccountView: tipo neutro PAGO com
    // bankLast4 cujo mês do pagamento === mês de vencimento da fatura).
    const existing = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        status: 'PAGO',
        cardLast4: card.last4,
        bankLast4: { not: null },
        deletedAt: null,
      },
      select: { dataPagamento: true, createdAt: true },
    });
    const alreadyPaid = existing.some(
      (e) => monthKeyOf(e.dataPagamento ?? e.createdAt) === month,
    );
    if (alreadyPaid) {
      throw new BadRequestException('Esta fatura já está marcada como paga neste mês.');
    }

    // A detecção de "fatura paga" casa o MÊS do pagamento com o mês de vencimento.
    // Para garantir coerência, a data efetiva do pagamento fica dentro do mês da
    // fatura: usa a data escolhida se cair no mês; senão, o dia do vencimento.
    const chosen = dto.paymentDate ? new Date(dto.paymentDate) : new Date();
    const effectiveDate =
      !Number.isNaN(chosen.getTime()) && monthKeyOf(chosen) === month
        ? chosen
        : new Date(`${dueDateIso(month, card.dueDay)}T12:00:00.000Z`);

    const payment = await this.prisma.expense.create({
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
      },
    });

    // Liquida as compras do ciclo (best-effort: nunca desfaz o pagamento se a
    // liquidação falhar — o pagamento neutro já reflete o caixa).
    let settled = { settledExpenses: 0, settledParcelas: 0 };
    try {
      settled = await this.cardSettlement.settleInvoice({
        tenantId,
        card,
        amountCents,
        paymentDate: effectiveDate,
      });
    } catch {
      // mantém o pagamento; liquidação das parcelas pode ser refeita por import.
    }

    return {
      ok: true,
      paymentExpenseId: payment.id,
      cardLast4: card.last4,
      month,
      amountCents,
      ...settled,
    };
  }

  private async ensurePessoalProject(tenantId: string, projectId: string) {
    const pessoal = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
    });
    if (!pessoal) throw new NotFoundException('Projeto não encontrado');
    if (pessoal.type !== 'PESSOAL') {
      throw new BadRequestException(
        'Visão consolidada disponível apenas para projetos do tipo PESSOAL',
      );
    }
    return pessoal;
  }
}

/** YYYY-MM em UTC (datas do banco são gravadas em UTC, sem deslocar timezone). */
function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface CaixaContaAccount {
  openingBalanceCents: number;
  openingBalanceDate: Date | null;
}
export interface CaixaContaExpense {
  valorTotal: number;
  status: string;
  dataPagamento: Date | null;
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
 * com `bankLast4` (filtrados pelo chamador). Cartão (sem bankLast4) e futuros
 * (status ≠ PAGO/EM_CAIXA) ficam de fora.
 */
export function computeCaixaConta(
  accounts: CaixaContaAccount[],
  expenses: CaixaContaExpense[],
  receipts: CaixaContaReceipt[],
) {
  const saldoInicial = accounts.reduce((s, a) => s + a.openingBalanceCents, 0);
  const temSaldoInicial = accounts.some(
    (a) => a.openingBalanceCents !== 0 || a.openingBalanceDate != null,
  );

  // Lançamentos realizados com sinal (despesa −, recebimento +) e mês de referência.
  const movs: Array<{ mes: string; valor: number }> = [];
  for (const e of expenses) {
    if (e.status !== 'PAGO') continue; // só realizados afetam o caixa
    const d = e.dataPagamento ?? e.createdAt;
    movs.push({ mes: monthKeyOf(d), valor: -e.valorTotal });
  }
  for (const r of receipts) {
    if (r.status !== 'EM_CAIXA') continue;
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
}

function normalizeMonthKey(month?: string): string {
  if (!month) {
    const now = new Date();
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
  return expense.dataPagamento ?? expense.dataInicioParcela ?? expense.createdAt;
}

function accountExpenseDate(expense: { dataPagamento: Date | null; createdAt: Date }): Date {
  return expense.dataPagamento ?? expense.createdAt;
}

function dueDateIso(monthKey: string, dueDay: number | null): string {
  const [year, month] = monthKey.split('-').map((value) => parseInt(value, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = dueDay == null ? 1 : Math.min(Math.max(dueDay, 1), lastDay);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function currentOpenInvoiceMonth(
  card: { closingDay: number | null; dueDay: number | null },
  today: Date,
): string {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  if (card.closingDay == null || card.dueDay == null) {
    return `${year}-${String(month + 1).padStart(2, '0')}`;
  }

  const todayStart = new Date(Date.UTC(year, month, today.getUTCDate()));
  const dueThisMonth = clampedUtcDate(year, month, card.dueDay);
  const target = dueThisMonth >= todayStart
    ? dueThisMonth
    : clampedUtcDate(year, month + 1, card.dueDay);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}`;
}

function clampedUtcDate(year: number, monthIndex0: number, day: number): Date {
  const lastDay = new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex0, Math.min(day, lastDay)));
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
