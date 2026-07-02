import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CardInvoiceSettlementService } from '../credit-card/card-invoice-settlement.service';
import {
  buildMonthlyOverview,
  caixaMonthForCardPurchase,
  compareMonths,
  ExpenseTypeLabels,
  ReceiptTypeLabels,
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
      include: { expense: { select: { linkedExpenseId: true, cardLast4: true, bankLast4: true } } },
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
      bankLast4: e.expense?.bankLast4 ?? null,
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

    const [accounts, allExpenses, receipts, entries, cards] = await Promise.all([
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
        where: { tenantId, deletedAt: null },
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
          quantidadeParcela: true,
          status: true,
          cardLast4: true,
          bankLast4: true,
          createdAt: true,
          linkedExpenseId: true,
          settledByExpenseId: true,
          settlesInvoiceKey: true,
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

    // O PESSOAL é o controlador universal do caixa: carregamos as despesas de
    // TODOS os projetos do tenant e particionamos. As do PESSOAL alimentam o
    // caixa/saídas (conta-only, §10); as de outros projetos servem para (a)
    // rotular a origem dos espelhos e (b) somar o planejado cross-project que
    // ainda sairá da conta pessoal em "Ainda falta pagar".
    const expenses = allExpenses.filter((expense) => expense.projectId === projectId);
    const foreignExpenses = allExpenses.filter((expense) => expense.projectId !== projectId);
    const foreignById = new Map(foreignExpenses.map((expense) => [expense.id, expense] as const));
    const linkedTargetIds = new Set(
      expenses.map((expense) => expense.linkedExpenseId).filter((id): id is string => !!id),
    );
    const projetoOrigemFor = (linkedExpenseId: string | null | undefined) => {
      if (!linkedExpenseId) return null;
      const target = foreignById.get(linkedExpenseId);
      if (!target?.project) return null;
      return { id: target.project.id, name: target.project.name, type: target.project.type };
    };

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

    // Faturas quitadas por dois mecanismos (ver computePaidInvoiceKeys):
    //  - implícito: pagamentos via conta do PRÓPRIO cartão, casados por valor+janela
    //    (faturas que vencem no dia 1 são pagas no mês anterior).
    //  - explícito: "cartão paga cartão"/PIX com `settlesInvoiceKey` apontando a fatura
    //    de OUTRO cartão (juros/parciais → soma, não casa por valor). Despesas com
    //    vínculo explícito saem do casamento implícito para não interferir.
    const settlementInvoices = Array.from(invoiceByMonthCard.values()).map((invoice) => ({
      dueMonth: invoice.dueMonth,
      cardLast4: invoice.cardLast4,
      total: invoice.total,
    }));
    const invoicePayments = expenses.filter(
      (expense) =>
        expense.tipoDespesa === 'PAGAMENTO_FATURA_CARTAO' && !!expense.cardLast4,
    );
    const implicitPayments = invoicePayments
      .filter(
        (expense) =>
          !expense.settlesInvoiceKey && expense.status === 'PAGO' && !!expense.bankLast4,
      )
      .map((expense) => ({
        payMonth: monthKeyOf(accountExpenseDate(expense)),
        cardLast4: expense.cardLast4 as string,
        amount: expense.valorTotal,
      }));
    const explicitSettlements = invoicePayments
      .filter((expense) => !!expense.settlesInvoiceKey)
      .map((expense) => ({
        targetKey: settlesInvoiceKeyToInternal(expense.settlesInvoiceKey as string),
        amount: expense.valorTotal,
      }));
    const paidInvoiceKeys = computePaidInvoiceKeys(
      settlementInvoices,
      implicitPayments,
      explicitSettlements,
    );

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

    const accountExpenseList = expenses
      .filter((expense) => {
        if (!expense.bankLast4 || expense.cardLast4) return false;
        if (isNeutralExpenseType(expense.tipoDespesa)) return false;
        return isInRange(accountExpenseDate(expense), monthStart, monthEnd);
      })
      .sort((a, b) => accountExpenseDate(a).getTime() - accountExpenseDate(b).getTime());

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

    // Planejado de outros projetos que ainda sairá da conta pessoal (o PESSOAL é o
    // consolidador). Deduplicado contra alvos já liquidados por um espelho pessoal
    // (linkedTargetIds) e contra planejados já liquidados (settledByExpenseId).
    const foreignPendingList = foreignExpenses
      .filter((expense) => {
        if (expense.status === 'PAGO') return false;
        if (expense.settledByExpenseId) return false;
        if (linkedTargetIds.has(expense.id)) return false;
        if (isNeutralExpenseType(expense.tipoDespesa)) return false;
        return isInRange(purchaseDate(expense), monthStart, monthEnd);
      })
      .sort((a, b) => purchaseDate(b).getTime() - purchaseDate(a).getTime());

    const faltaPagarMes =
      sumBy(selectedInvoices, (invoice) => invoice.pending) +
      sumBy(
        accountExpenseList.filter((expense) => expense.status !== 'PAGO'),
        (expense) => expense.valorTotal,
      ) +
      sumBy(foreignPendingList, (expense) => expense.valorTotal);

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
        projetoOrigem: null as { id: string; name: string; type: string } | null,
      })),
      ...accountExpenseList.map((expense) => ({
        id: expense.id as string | null,
        kind: 'saida' as const,
        descricao: expenseDisplayName(expense.tipoDespesa, expense.titulo, expense.fornecedor),
        data: accountExpenseDate(expense).toISOString(),
        forma: inferCashForm(
          `${expense.titulo ?? ''} ${expense.fornecedor ?? ''}`,
          expense.formaPagamento,
        ),
        valor: expense.valorTotal,
        realizado: expense.status === 'PAGO',
        status: expense.status,
        cardLast4: null as string | null,
        bankLast4: expense.bankLast4,
        tipoDespesa: expense.tipoDespesa,
        isInvoice: false,
        editavel: true,
        dueMonth: null as string | null,
        projetoOrigem: projetoOrigemFor(expense.linkedExpenseId),
      })),
      ...foreignPendingList.map((expense) => ({
        id: expense.id as string | null,
        kind: 'saida' as const,
        descricao: expenseDisplayName(expense.tipoDespesa, expense.titulo, expense.fornecedor),
        data: purchaseDate(expense).toISOString(),
        forma: inferCashForm(
          `${expense.titulo ?? ''} ${expense.fornecedor ?? ''}`,
          expense.formaPagamento,
        ),
        valor: expense.valorTotal,
        realizado: false,
        status: expense.status,
        cardLast4: null as string | null,
        bankLast4: null as string | null,
        tipoDespesa: expense.tipoDespesa,
        isInvoice: false,
        editavel: false,
        dueMonth: null as string | null,
        projetoOrigem: expense.project
          ? { id: expense.project.id, name: expense.project.name, type: expense.project.type }
          : null,
      })),
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
      recebimentosPrevistosMes,
      sobraPrevista: caixa.hoje - faltaPagarMes + recebimentosPrevistosMes,
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

  async getDreOverview(
    tenantId: string,
    projectId: string,
    params?: { month?: string; year?: string | number },
  ) {
    await this.ensurePessoalProject(tenantId, projectId);

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
    const accountView = await this.getAccountView(tenantId, projectId, mesSelecionado);

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
      accountView.entradas.map((entrada) => ({
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

    const resultadoMes = totalEntrou - totalSaiuCompetencia - totalGuardadoMes;
    const resultadoMesAnterior = dreMonthResult(
      normalized,
      monthKeyPlus(mesSelecionado, -1),
    );
    const deltaVsMesAnterior =
      resultadoMesAnterior === 0
        ? 0
        : roundPct(((resultadoMes - resultadoMesAnterior) / Math.abs(resultadoMesAnterior)) * 100);

    const months = Array.from({ length: 12 }, (_, i) => `${anoSelecionado}-${String(i + 1).padStart(2, '0')}`);
    const now = new Date();
    const realizedUntil =
      anoSelecionado < now.getUTCFullYear()
        ? 12
        : anoSelecionado === now.getUTCFullYear()
          ? now.getUTCMonth() + 1
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
        resultado: receitas - despesas - guardado,
        margem,
        isCritical: receitas > 0 && despesas / receitas > 0.9,
      };
    });

    const realizedRows = monthRows.filter((row) => row.monthIndex <= realizedUntil);
    const totalEntrouAno = sumBy(realizedRows, (row) => row.receitas);
    const totalSaiuAno = sumBy(realizedRows, (row) => row.despesas);
    const totalGuardadoAno = sumBy(realizedRows, (row) => row.guardado);
    const resultadoAcumulado = totalEntrouAno - totalSaiuAno - totalGuardadoAno;
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
        resultadoAcumulado,
        mediaMensal,
        mesCritico: {
          mes: mesCriticoBase?.mes ?? `${anoSelecionado}-01`,
          margem: mesCriticoBase?.margem ?? 0,
        },
        serie,
        totaisEntradas,
        totaisSaidas,
        totaisGuardado,
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
  async getCardInvoicesYearly(tenantId: string, projectId: string, year?: string | number) {
    await this.ensurePessoalProject(tenantId, projectId);

    const targetYear = normalizeYear(year);

    const [entries, cards, accounts] = await Promise.all([
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
            select: { cardLast4: true, bankLast4: true, tipoDespesa: true },
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

    const originKey = (kind: 'card' | 'conta', last4: string) => `${kind}:${last4}`;

    // Mapa: `${YYYY-MM}__${originKey}` -> total em centavos (apenas o ano alvo).
    const totalsByMonthOrigin = new Map<string, number>();
    const cardsWithData = new Set<string>();
    const accountsWithData = new Set<string>();

    for (const entry of entries) {
      const cardLast4 = entry.expense?.cardLast4;
      const bankLast4 = entry.expense?.bankLast4;
      const tipo = entry.expense?.tipoDespesa;

      let key: string;
      let mes: string;

      if (cardLast4) {
        // Cartão: neutros liquidados via conta ficam de fora; cobrança neutra no
        // cartão entra. Agrupa por mês de vencimento.
        if (isNeutralExpenseType(tipo) && bankLast4) continue;
        const card = cardByLast4.get(cardLast4) ?? null;
        mes = caixaMonthForCardPurchase(entry.data, card?.closingDay ?? null, card?.dueDay ?? null);
        key = originKey('card', cardLast4);
        cardsWithData.add(cardLast4);
      } else if (bankLast4) {
        // Conta corrente: exclui todos os neutros; agrupa pelo mês do débito.
        if (isNeutralExpenseType(tipo)) continue;
        mes = monthKeyOf(entry.data);
        key = originKey('conta', bankLast4);
        accountsWithData.add(bankLast4);
      } else {
        continue;
      }

      if (!mes.startsWith(`${targetYear}-`)) continue;
      const mapKey = `${mes}__${key}`;
      totalsByMonthOrigin.set(mapKey, (totalsByMonthOrigin.get(mapKey) ?? 0) + entry.valor);
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
    ];

    const monthLabels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const months = Array.from({ length: 12 }, (_, index) => {
      const mes = `${targetYear}-${String(index + 1).padStart(2, '0')}`;
      const porOrigem: Record<string, number> = {};
      let total = 0;
      for (const origin of origins) {
        const value = totalsByMonthOrigin.get(`${mes}__${origin.key}`) ?? 0;
        porOrigem[origin.key] = value;
        total += value;
      }
      return { mes, label: monthLabels[index], porOrigem, total };
    });

    const totalAno = months.reduce((sum, month) => sum + month.total, 0);

    return { year: targetYear, origins, months, totalAno };
  }

  /**
   * Despesas relacionadas a UMA origem (cartão ou conta corrente) ao longo de um
   * ano — usado para listar abaixo do gráfico quando o usuário filtra por origem.
   * Aplica a MESMA regra de neutros/mês do getCardInvoicesYearly.
   */
  async getOriginItemsYearly(
    tenantId: string,
    projectId: string,
    params: { year?: string | number; kind?: string; last4?: string },
  ) {
    await this.ensurePessoalProject(tenantId, projectId);

    const targetYear = normalizeYear(params.year);
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
        ? await this.prisma.creditCard.findFirst({
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
        if (isNeutralExpenseType(tipo)) continue;
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
    const total = items.reduce((sum, item) => sum + item.valor, 0);

    return { year: targetYear, kind, last4, items, total };
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

/**
 * Casa pagamentos de fatura (`PAGAMENTO_FATURA_CARTAO` pagos via conta) às faturas
 * do mesmo cartão. O pagamento de uma fatura é feito no mês do vencimento OU no mês
 * anterior (faturas que vencem no dia 1 são pagas no fim do mês anterior). Por isso
 * casamos POR VALOR dentro da janela de mês `{payMonth, payMonth+1}`, processando os
 * pagamentos em ordem cronológica e consumindo cada fatura uma única vez. Retorna o
 * conjunto de chaves `${dueMonth}__${cardLast4}` das faturas quitadas.
 */
export function matchPaidInvoices(
  invoices: InvoiceForMatch[],
  payments: PaymentForMatch[],
): Set<string> {
  const paid = new Set<string>();

  const invoicesByCard = new Map<string, InvoiceForMatch[]>();
  for (const invoice of invoices) {
    const list = invoicesByCard.get(invoice.cardLast4) ?? [];
    list.push(invoice);
    invoicesByCard.set(invoice.cardLast4, list);
  }

  const paymentsByCard = new Map<string, PaymentForMatch[]>();
  for (const payment of payments) {
    const list = paymentsByCard.get(payment.cardLast4) ?? [];
    list.push(payment);
    paymentsByCard.set(payment.cardLast4, list);
  }

  for (const [cardLast4, cardPayments] of paymentsByCard) {
    const cardInvoices = invoicesByCard.get(cardLast4) ?? [];
    const matchedDueMonths = new Set<string>();
    const ordered = [...cardPayments].sort(
      (a, b) => a.payMonth.localeCompare(b.payMonth) || a.amount - b.amount,
    );
    for (const payment of ordered) {
      const windowMonths = [payment.payMonth, monthKeyPlus(payment.payMonth, 1)];
      const candidates = cardInvoices.filter(
        (invoice) =>
          !matchedDueMonths.has(invoice.dueMonth) && windowMonths.includes(invoice.dueMonth),
      );
      if (candidates.length === 0) continue;
      candidates.sort(
        (a, b) =>
          Math.abs(a.total - payment.amount) - Math.abs(b.total - payment.amount) ||
          a.dueMonth.localeCompare(b.dueMonth),
      );
      const chosen = candidates[0];
      matchedDueMonths.add(chosen.dueMonth);
      paid.add(`${chosen.dueMonth}__${cardLast4}`);
    }
  }

  return paid;
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
): Set<string> {
  const paid = matchPaidInvoices(invoices, implicitPayments);

  const sumByKey = new Map<string, number>();
  for (const settlement of explicitSettlements) {
    sumByKey.set(settlement.targetKey, (sumByKey.get(settlement.targetKey) ?? 0) + settlement.amount);
  }
  const totalByKey = new Map<string, number>(
    invoices.map((invoice) => [`${invoice.dueMonth}__${invoice.cardLast4}`, invoice.total] as const),
  );
  for (const [key, sum] of sumByKey) {
    const total = totalByKey.get(key);
    if (total != null && sum >= total) paid.add(key);
  }

  return paid;
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
  const guardado = sumBy(
    lines.filter(
      (line) =>
        line.kind === 'saida' &&
        line.realizado &&
        !!line.isGuardado &&
        line.mesCompetencia === mes,
    ),
    (line) => line.valor,
  );
  return entrou - saiu - guardado;
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

function normalizeYear(year?: string | number): number {
  if (year === undefined || year === null || year === '') {
    return new Date().getUTCFullYear();
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
