import { Injectable } from '@nestjs/common';
import {
  ExpenseType,
  ReceiptType,
  getExpenseTaxonomy,
  getTaxonomyTree,
  EssentialityLabels,
} from '@reformaflow/domain';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantFinancialService } from '../../tenant-financial/tenant-financial.service';
import { ExpenseService } from '../../expense/expense.service';
import { ReceiptService } from '../../receipt/receipt.service';
import { CreditCardService } from '../../credit-card/credit-card.service';
import { BankAccountService } from '../../bank-account/bank-account.service';
import {
  isFullAccessRole,
  projectTypeHasModule,
  userCanAccessProject,
} from '../../common/access-rules';
import type { ModuleSlug } from '../../common/decorators/require-module.decorator';
import { ToolDef } from '../llm/llm.types';

export interface ToolContext {
  tenantId: string;
  /** Projeto em foco quando o chat é aberto dentro de um projeto (opcional). */
  projectId?: string | null;
  /** Escopo de projetos acessíveis (null = sem restrição). Aplica ACL por projeto. */
  projectScope?: string[] | null;
  /** Papel do usuário (ADMIN/OWNER/USER) — usado nas ferramentas de escrita. */
  role?: string;
  /** Módulos liberados ao usuário — usado nas ferramentas de escrita. */
  allowedModules?: string[];
}

interface ToolHandler {
  def: ToolDef;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Registry de ferramentas de LEITURA do agente financeiro.
 * Todas são tenant-scoped (recebem tenantId do contexto autenticado) e reusam
 * serviços existentes. Valores monetários são retornados em CENTAVOS.
 */
@Injectable()
export class AgentToolsService {
  private readonly handlers: Record<string, ToolHandler>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly financial: TenantFinancialService,
    private readonly expenses: ExpenseService,
    private readonly receipts: ReceiptService,
    private readonly cards: CreditCardService,
    private readonly accounts: BankAccountService,
  ) {
    this.handlers = this.buildHandlers();
  }

  getToolDefs(): ToolDef[] {
    return Object.values(this.handlers).map((h) => h.def);
  }

  /**
   * Resumo de contexto injetado no início da conversa para REDUZIR chamadas ao
   * LLM: com projetos e meios de pagamento já listados, o agente não precisa
   * chamar list_projects / list_payment_methods antes de registrar algo —
   * economiza requisições (importante no free tier por-minuto do LLM).
   */
  async buildPrimer(ctx: ToolContext): Promise<string> {
    const scope = ctx.projectScope ?? null;
    const whereProj = { tenantId: ctx.tenantId, deletedAt: null, ...(scope ? { id: { in: scope } } : {}) };
    const wherePay = { tenantId: ctx.tenantId, deletedAt: null, ...(scope ? { projectId: { in: scope } } : {}) };
    const [projects, cards, accounts] = await Promise.all([
      this.prisma.project.findMany({ where: whereProj, select: { id: true, name: true, type: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.creditCard.findMany({ where: wherePay, select: { id: true, nickname: true, institution: true, last4: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.bankAccount.findMany({ where: wherePay, select: { id: true, nickname: true, institution: true, last4: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    if (projects.length === 0) return '';

    const projLines = projects.map((p) => `  - ${p.name} [${p.type}] id=${p.id}`).join('\n');
    const cardLines = cards.length
      ? cards.map((c) => `  - cartão ${c.nickname ?? c.institution} (final ${c.last4}) creditCardId=${c.id}`).join('\n')
      : '  (nenhum)';
    const accLines = accounts.length
      ? accounts.map((a) => `  - conta ${a.nickname ?? a.institution} (final ${a.last4}) bankAccountId=${a.id}`).join('\n')
      : '  (nenhuma)';

    return [
      'CONTEXTO DO USUÁRIO (use estes ids diretamente; só chame list_projects/list_payment_methods se algo não estiver aqui):',
      'Projetos:',
      projLines,
      'Cartões:',
      cardLines,
      'Contas bancárias:',
      accLines,
    ].join('\n');
  }

  async execute(name: string, ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers[name];
    if (!handler) {
      return { error: `Ferramenta desconhecida: ${name}` };
    }
    try {
      return await handler.run(ctx, args || {});
    } catch (e) {
      const message = e instanceof Error ? e.message : 'erro desconhecido';
      return { error: `Falha ao executar ${name}: ${message}` };
    }
  }

  private buildHandlers(): Record<string, ToolHandler> {
    const noParams = { type: 'object', properties: {}, additionalProperties: false };

    return {
      list_projects: {
        def: {
          name: 'list_projects',
          description:
            'Lista todos os projetos do usuário (id, nome, tipo). Use para descobrir os projetos disponíveis e resolver nomes para ids.',
          parameters: noParams,
        },
        run: async (ctx) => {
          const scope = ctx.projectScope ?? null;
          const projects = await this.prisma.project.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, ...(scope ? { id: { in: scope } } : {}) },
            select: { id: true, name: true, type: true },
            orderBy: { createdAt: 'asc' },
          });
          return { projects };
        },
      },

      get_financial_overview: {
        def: {
          name: 'get_financial_overview',
          description:
            'KPIs financeiros consolidados de TODOS os projetos: caixa total, pago no mês/ano/total, previsões de gastos e recebimentos para 30/90 dias, saldo projetado. Valores em centavos.',
          parameters: noParams,
        },
        run: async (ctx) => this.financial.getOverview(ctx.tenantId, ctx.projectScope ?? null),
      },

      get_by_project: {
        def: {
          name: 'get_by_project',
          description:
            'Breakdown financeiro por projeto: gasto total, planejado restante, recebimentos, saldo e progresso de cada projeto. Valores em centavos.',
          parameters: noParams,
        },
        run: async (ctx) => ({ projects: await this.financial.getByProject(ctx.tenantId, ctx.projectScope ?? null) }),
      },

      get_expenses_by_category: {
        def: {
          name: 'get_expenses_by_category',
          description:
            'Total de despesas por categoria/tipo (todos os projetos no escopo), JÁ CLASSIFICADO pela ontologia: cada categoria vem com grupo-pai e essencialidade (ESSENCIAL/SUPERFLUO/INVESTIMENTO/NEUTRO/PROJETO/INDEFINIDO). ' +
            'Inclui um resumo por essencialidade — use para "para onde foi meu dinheiro" e "essencial vs supérfluo". Valores em centavos.',
          parameters: noParams,
        },
        run: async (ctx) => {
          const categorias = await this.financial.getByCategory(ctx.tenantId, ctx.projectScope ?? null);
          const enriquecidas = categorias.map((c) => {
            const tax = getExpenseTaxonomy(c.key);
            return {
              ...c,
              grupo: tax?.group ?? 'Outros',
              essencialidade: tax?.essentiality ?? 'INDEFINIDO',
              essencialidadeLabel: tax?.essentialityLabel ?? EssentialityLabels['INDEFINIDO'],
            };
          });
          const porEssencialidade: Record<string, number> = {};
          for (const c of enriquecidas) {
            porEssencialidade[c.essencialidade] = (porEssencialidade[c.essencialidade] ?? 0) + c.total;
          }
          return { categorias: enriquecidas, resumoPorEssencialidade: porEssencialidade };
        },
      },

      get_category_taxonomy: {
        def: {
          name: 'get_category_taxonomy',
          description:
            'Ontologia de categorias de despesa: árvore grupo-pai → tipos, com a essencialidade de cada um ' +
            '(ESSENCIAL, SUPERFLUO, INVESTIMENTO, NEUTRO, PROJETO, INDEFINIDO) e sinônimos. ' +
            'Use para entender como classificar gastos de forma consistente (essencial × supérfluo), ' +
            'mapear um termo do usuário ao tipo correto, ou explicar a classificação. Não recebe parâmetros.',
          parameters: noParams,
        },
        run: async () => ({
          essencialidades: EssentialityLabels,
          grupos: getTaxonomyTree().map((g) => ({
            grupo: g.group,
            tipos: g.types.map((t) => ({
              tipo: t.type,
              label: t.label,
              essencialidade: t.essentiality,
              sinonimos: t.synonyms,
            })),
          })),
        }),
      },

      get_upcoming: {
        def: {
          name: 'get_upcoming',
          description:
            'Despesas e recebimentos com vencimento nos próximos N dias (default 30), em todos os projetos. Use para "o que vence", "próximos pagamentos". Valores em centavos.',
          parameters: {
            type: 'object',
            properties: {
              days: { type: 'integer', description: 'Janela em dias (1 a 365). Default 30.' },
            },
            additionalProperties: false,
          },
        },
        run: async (ctx, args) => {
          const days = this.clampInt(args['days'], 30, 1, 365);
          return { dias: days, itens: await this.financial.getUpcoming(ctx.tenantId, days, ctx.projectScope ?? null) };
        },
      },

      get_top_suppliers: {
        def: {
          name: 'get_top_suppliers',
          description:
            'Maiores fornecedores por total gasto (todos os projetos). Use para "onde gasto mais", "principais fornecedores". Valores em centavos.',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'integer', description: 'Quantidade de fornecedores (1 a 20). Default 5.' },
            },
            additionalProperties: false,
          },
        },
        run: async (ctx, args) => {
          const limit = this.clampInt(args['limit'], 5, 1, 20);
          return { fornecedores: await this.financial.getTopSuppliers(ctx.tenantId, limit, ctx.projectScope ?? null) };
        },
      },

      create_expense: {
        def: {
          name: 'create_expense',
          description:
            'Cadastra uma DESPESA num projeto a partir de linguagem natural. ' +
            'Use quando o usuário disser que gastou/pagou/comprou algo (ex.: "gastei 250 reais de material na Obramax", "paguei 1.200 ao pintor"). ' +
            'O valor é em REAIS (será convertido). Se o usuário não indicar o projeto e houver um projeto em foco, use-o; senão chame list_projects e peça para o usuário escolher. ' +
            'Para vincular a um cartão de crédito ou conta bancária ("comprei no cartão Nubank", "saiu da conta do Itaú"), primeiro chame list_payment_methods para achar o id e passe creditCardId ou bankAccountId. ' +
            'Confirme valor, projeto e descrição com o usuário antes de criar quando houver ambiguidade.',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: 'Id do projeto (use list_projects para resolver pelo nome). Opcional se há projeto em foco.' },
              valor: { type: 'number', description: 'Valor unitário em REAIS (ex.: 250.50). Obrigatório.' },
              quantidade: { type: 'integer', description: 'Quantidade (default 1).' },
              tipoDespesa: { type: 'string', description: 'Categoria da despesa. Ex.: MATERIAL_CONSTRUCAO, MAO_DE_OBRA, ALIMENTACAO, TRANSPORTE, SAUDE, MORADIA, SUPERMERCADO, LAZER, OUTROS. Use OUTROS se não tiver certeza.' },
              titulo: { type: 'string', description: 'Descrição curta (ex.: "Cimento e areia").' },
              fornecedor: { type: 'string', description: 'Nome do fornecedor/loja (ex.: "Obramax").' },
              data: { type: 'string', description: 'Data REAL da compra (competência) no formato YYYY-MM-DD. Default: hoje. Para cartão, o vencimento da fatura é derivado automaticamente desta data.' },
              formaPagamento: { type: 'string', enum: ['A_VISTA', 'PARCELADO', 'QUINZENAL', 'PIX', 'PAGAMENTO_CONTA'], description: 'Forma de pagamento (default A_VISTA).' },
              quantidadeParcela: { type: 'integer', description: 'Número de parcelas (use com formaPagamento=PARCELADO). Ex.: "em 3x" -> 3.' },
              status: { type: 'string', enum: ['PAGO', 'PLANEJADO'], description: 'PAGO se já foi pago; PLANEJADO se é uma despesa futura/prevista. Default PAGO.' },
              creditCardId: { type: 'string', description: 'Id do cartão de crédito a vincular (obtido via list_payment_methods).' },
              bankAccountId: { type: 'string', description: 'Id da conta bancária a vincular (obtido via list_payment_methods).' },
              linkedExpenseId: { type: 'string', description: 'Id de uma despesa de OUTRO projeto para vincular (cross-project, evita dupla contagem). Use find_expenses para localizar a despesa-alvo.' },
            },
            required: ['valor'],
            additionalProperties: false,
          },
        },
        run: async (ctx, args) => {
          const project = await this.resolveWritableProject(ctx, args['projectId'], 'expenses');
          const valor = this.parseMoney(args['valor']);
          if (valor == null) return { error: 'Informe um valor em reais maior que zero.' };

          const tipoDespesa = this.normalizeEnum(args['tipoDespesa'], ExpenseType, 'OUTROS');
          const status = this.pickEnumStr(args['status'], ['PAGO', 'PLANEJADO'], 'PAGO');
          const quantidadeParcela = this.optInt(args['quantidadeParcela'], 2, 60);
          const formaPagamento = this.pickEnumStr(
            args['formaPagamento'],
            ['A_VISTA', 'PARCELADO', 'QUINZENAL', 'PIX', 'PAGAMENTO_CONTA'],
            quantidadeParcela ? 'PARCELADO' : 'A_VISTA',
          );
          const quantidade = this.clampInt(args['quantidade'], 1, 1, 100000);
          const data = this.optDate(args['data']);

          // Valida vínculos (projeto-alvo do cartão/conta/despesa deve estar no escopo do usuário).
          const creditCardId = await this.resolvePaymentRef(ctx, args['creditCardId'], 'card');
          const bankAccountId = await this.resolvePaymentRef(ctx, args['bankAccountId'], 'account');
          const linkedExpenseId = await this.resolveLinkedExpense(ctx, args['linkedExpenseId'], project.id);

          const parcelado = formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL';

          const created = await this.expenses.create(ctx.tenantId, project.id, {
            tipoDespesa,
            valor,
            quantidade,
            formaPagamento,
            status,
            titulo: this.optStr(args['titulo']),
            fornecedor: this.optStr(args['fornecedor']),
            // À vista: a data vira dataPagamento. Parcelado: vira dataInicioParcela.
            dataPagamento: parcelado ? undefined : data,
            dataInicioParcela: parcelado ? data : undefined,
            // A data informada é a DATA DA COMPRA (competência). Mantida em ambos
            // os eixos: competência usa dataCompra; o caixa deriva o vencimento
            // da fatura do cartão a partir dela.
            dataCompra: data,
            quantidadeParcela: formaPagamento === 'PARCELADO' ? quantidadeParcela ?? undefined : undefined,
            creditCardId,
            bankAccountId,
            linkedExpenseId,
          } as any);

          return {
            ok: true,
            despesa: {
              id: created.id,
              projeto: project.name,
              tipoDespesa,
              titulo: created.titulo ?? null,
              fornecedor: created.fornecedor ?? null,
              valorTotalCentavos: created.valorTotal,
              status,
              formaPagamento,
              quantidadeParcela: formaPagamento === 'PARCELADO' ? quantidadeParcela ?? null : null,
              data: data ?? new Date().toISOString().slice(0, 10),
              cardLast4: created.cardLast4 ?? null,
              bankLast4: created.bankLast4 ?? null,
              linkedExpenseId: created.linkedExpenseId ?? null,
            },
            mensagem: `Despesa registrada em "${project.name}".`,
          };
        },
      },

      list_payment_methods: {
        def: {
          name: 'list_payment_methods',
          description:
            'Lista cartões de crédito e contas bancárias disponíveis (id, apelido/instituição, final do número, projeto). ' +
            'Use para resolver o nome citado pelo usuário ("cartão Nubank", "conta do Itaú") no id correto antes de vincular numa despesa (creditCardId/bankAccountId).',
          parameters: noParams,
        },
        run: async (ctx) => {
          const scope = ctx.projectScope ?? null;
          const where = { tenantId: ctx.tenantId, deletedAt: null, ...(scope ? { projectId: { in: scope } } : {}) };
          const [cards, accounts] = await Promise.all([
            this.prisma.creditCard.findMany({
              where,
              select: { id: true, last4: true, nickname: true, institution: true, project: { select: { name: true } } },
              orderBy: { createdAt: 'asc' },
            }),
            this.prisma.bankAccount.findMany({
              where,
              select: { id: true, last4: true, nickname: true, institution: true, project: { select: { name: true } } },
              orderBy: { createdAt: 'asc' },
            }),
          ]);
          return {
            cartoes: cards.map((c) => ({ creditCardId: c.id, apelido: c.nickname ?? c.institution ?? null, final: c.last4 ?? null, projeto: c.project?.name ?? null })),
            contas: accounts.map((a) => ({ bankAccountId: a.id, apelido: a.nickname ?? a.institution ?? null, final: a.last4 ?? null, projeto: a.project?.name ?? null })),
          };
        },
      },

      find_expenses: {
        def: {
          name: 'find_expenses',
          description:
            'Busca despesas existentes (id, projeto, título, fornecedor, valor, data, tipo) — útil para localizar a despesa-alvo de um vínculo cross-project (linkedExpenseId no create_expense). ' +
            'Filtre por projeto e/ou por um texto (busca em título e fornecedor).',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: 'Restringe a um projeto (opcional).' },
              query: { type: 'string', description: 'Texto a buscar em título/fornecedor (opcional).' },
              limit: { type: 'integer', description: 'Máximo de resultados (1 a 25, default 10).' },
            },
            additionalProperties: false,
          },
        },
        run: async (ctx, args) => {
          const scope = ctx.projectScope ?? null;
          const projectId = this.optStr(args['projectId']);
          if (projectId && scope && !scope.includes(projectId)) {
            throw new Error('Sem permissão para acessar este projeto.');
          }
          const q = this.optStr(args['query']);
          const limit = this.clampInt(args['limit'], 10, 1, 25);
          const where: Record<string, unknown> = {
            tenantId: ctx.tenantId,
            deletedAt: null,
            settledByExpenseId: null,
            ...(projectId ? { projectId } : scope ? { projectId: { in: scope } } : {}),
            ...(q ? { OR: [{ titulo: { contains: q } }, { fornecedor: { contains: q } }] } : {}),
          };
          const rows = await this.prisma.expense.findMany({
            where: where as never,
            select: {
              id: true, titulo: true, fornecedor: true, valorTotal: true,
              tipoDespesa: true, dataPagamento: true,
              project: { select: { name: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });
          return {
            despesas: rows.map((r) => ({
              expenseId: r.id,
              projeto: r.project?.name ?? null,
              titulo: r.titulo ?? null,
              fornecedor: r.fornecedor ?? null,
              valorTotalCentavos: r.valorTotal,
              tipoDespesa: r.tipoDespesa,
              data: r.dataPagamento ? r.dataPagamento.toISOString().slice(0, 10) : null,
            })),
          };
        },
      },

      get_cashflow_history: {
        def: {
          name: 'get_cashflow_history',
          description:
            'Série mensal consolidada (últimos N meses, default 6): por mês retorna pago (despesas), planejado, recebido (entradas) e saldo acumulado. ' +
            'Use para tendência do patrimônio/caixa, TAXA DE POUPANÇA (recebido − pago no período) e detectar "buracos" futuros. Valores em centavos.',
          parameters: {
            type: 'object',
            properties: {
              months: { type: 'integer', description: 'Janela em meses (1 a 36, default 6).' },
            },
            additionalProperties: false,
          },
        },
        run: async (ctx, args) => {
          const months = this.clampInt(args['months'], 6, 1, 36);
          const serie = await this.financial.getCashFlow(ctx.tenantId, months, ctx.projectScope ?? null);
          const totalRecebido = serie.reduce((s, p) => s + p.recebido, 0);
          const totalPago = serie.reduce((s, p) => s + p.pago, 0);
          return {
            meses: serie.map((p) => ({ mes: p.mes, pago: p.pago, planejado: p.planejado, recebido: p.recebido, previsto: p.previsto, saldoAcumulado: p.saldoAcumulado })),
            resumo: {
              meses: months,
              totalRecebido,
              totalPago,
              poupancaPeriodo: totalRecebido - totalPago,
              taxaPoupancaPercent: totalRecebido > 0 ? Math.round(((totalRecebido - totalPago) / totalRecebido) * 100) : null,
            },
          };
        },
      },

      get_recurring_bills: {
        def: {
          name: 'get_recurring_bills',
          description:
            'Lista contas/assinaturas recorrentes ATIVAS (nome, categoria, valor, frequência, próximo vencimento) e o custo MENSAL normalizado total. ' +
            'Use para "assinaturas que drenam dinheiro", custos fixos e choques anuais (IPVA, seguro, IPTU). Valores em centavos.',
          parameters: noParams,
        },
        run: async (ctx) => {
          const scope = ctx.projectScope ?? null;
          const bills = await this.prisma.recurringBill.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, status: 'ATIVO', ...(scope ? { projectId: { in: scope } } : {}) },
            select: { nome: true, categoria: true, valor: true, frequencia: true, proximoVencimento: true, project: { select: { name: true } } },
            orderBy: { proximoVencimento: 'asc' },
          });
          const perMonthFactor: Record<string, number> = { MENSAL: 1, BIMESTRAL: 1 / 2, TRIMESTRAL: 1 / 3, SEMESTRAL: 1 / 6, ANUAL: 1 / 12 };
          let custoMensalCentavos = 0;
          const itens = bills.map((b) => {
            custoMensalCentavos += Math.round(b.valor * (perMonthFactor[b.frequencia] ?? 1));
            return {
              nome: b.nome,
              categoria: b.categoria,
              valorCentavos: b.valor,
              frequencia: b.frequencia,
              proximoVencimento: b.proximoVencimento ? b.proximoVencimento.toISOString().slice(0, 10) : null,
              projeto: b.project?.name ?? null,
            };
          });
          return { itens, custoMensalCentavos, custoAnualCentavos: custoMensalCentavos * 12 };
        },
      },

      get_account_balances: {
        def: {
          name: 'get_account_balances',
          description:
            'Componentes de PATRIMÔNIO: saldo de cada conta bancária (movimento de entradas − despesas pagas) e a FATURA ABERTA de cada cartão (dívida atual). ' +
            'Use para estimar patrimônio líquido (saldos − dívida de cartões) e RESERVA DE EMERGÊNCIA. ' +
            'IMPORTANTE: investimentos, financiamentos e outros ativos/dívidas NÃO são rastreados aqui — pergunte ao usuário e some manualmente. Valores em centavos.',
          parameters: noParams,
        },
        run: async (ctx) => {
          const scope = ctx.projectScope ?? null;
          const projects = await this.prisma.project.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, ...(scope ? { id: { in: scope } } : {}) },
            select: { id: true, name: true },
          });

          const contas: { conta: string; projeto: string; saldoCentavos: number }[] = [];
          const cartoes: { cartao: string; projeto: string; faturaAbertaCentavos: number; limiteCentavos: number | null }[] = [];

          for (const p of projects) {
            const [accs, cards] = await Promise.all([
              this.accounts.listAccounts(ctx.tenantId, p.id),
              this.cards.listOpenInvoices(ctx.tenantId, p.id),
            ]);
            for (const a of accs as Array<{ nickname: string; balanceCents?: number }>) {
              contas.push({ conta: a.nickname, projeto: p.name, saldoCentavos: a.balanceCents ?? 0 });
            }
            for (const c of cards) {
              cartoes.push({ cartao: c.nickname, projeto: p.name, faturaAbertaCentavos: c.openInvoiceUsedCents, limiteCentavos: c.limitTotalCents });
            }
          }

          const saldoBancarioTotal = contas.reduce((s, c) => s + c.saldoCentavos, 0);
          const dividaCartoesTotal = cartoes.reduce((s, c) => s + c.faturaAbertaCentavos, 0);
          return {
            contas,
            cartoes,
            totais: {
              saldoBancarioTotalCentavos: saldoBancarioTotal,
              dividaCartoesTotalCentavos: dividaCartoesTotal,
              patrimonioParcialCentavos: saldoBancarioTotal - dividaCartoesTotal,
              observacao: 'Parcial: não inclui investimentos/financiamentos não rastreados. Pergunte ao usuário para completar.',
            },
          };
        },
      },

      create_receipt: {
        def: {
          name: 'create_receipt',
          description:
            'Cadastra um RECEBIMENTO (entrada de dinheiro) num projeto a partir de linguagem natural. ' +
            'Use quando o usuário disser que recebeu/entrou dinheiro (ex.: "recebi 5 mil de salário", "entrou 800 de freelance"). ' +
            'O valor é em REAIS. Mesmo critério de projeto do create_expense (foco atual ou list_projects). ' +
            'Confirme valor e projeto com o usuário quando houver ambiguidade.',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: 'Id do projeto. Opcional se há projeto em foco.' },
              valor: { type: 'number', description: 'Valor em REAIS (ex.: 5000). Obrigatório.' },
              data: { type: 'string', description: 'Data no formato YYYY-MM-DD. Default: hoje.' },
              tipo: { type: 'string', description: 'Tipo do recebimento. Ex.: SALARIO, PAGAMENTO, FREELANCE, ALUGUEL, REEMBOLSO, PIX_RECEBIDO, OUTROS. Use OUTROS se não tiver certeza.' },
              status: { type: 'string', enum: ['EM_CAIXA', 'PREVISTO'], description: 'EM_CAIXA se o dinheiro já entrou; PREVISTO se é uma entrada futura. Default EM_CAIXA.' },
            },
            required: ['valor'],
            additionalProperties: false,
          },
        },
        run: async (ctx, args) => {
          const project = await this.resolveWritableProject(ctx, args['projectId'], 'receipts');
          const valor = this.parseMoney(args['valor']);
          if (valor == null) return { error: 'Informe um valor em reais maior que zero.' };

          const tipo = this.normalizeEnum(args['tipo'], ReceiptType, 'OUTROS');
          const status = this.pickEnumStr(args['status'], ['EM_CAIXA', 'PREVISTO'], 'EM_CAIXA');
          const data = this.optDate(args['data']) ?? new Date().toISOString().slice(0, 10);

          const created = await this.receipts.create(ctx.tenantId, project.id, {
            valor,
            data,
            tipo,
            status,
          } as any);

          return {
            ok: true,
            recebimento: {
              id: created.id,
              projeto: project.name,
              tipo,
              valorCentavos: created.valor,
              data,
              status,
            },
            mensagem: `Recebimento registrado em "${project.name}".`,
          };
        },
      },

      create_obra_expense: {
        def: {
          name: 'create_obra_expense',
          description:
            'Registra uma despesa de um PROJETO de obra/aquisição (REFORMA/COMPRA/CASA/CARRO) que foi PAGA com dinheiro pessoal. ' +
            'Cria DOIS lados vinculados, sem duplicar: (1) a despesa no projeto da obra (registro da obra, aparece no controle do projeto e no consolidado) e ' +
            '(2) um ESPELHO no projeto PESSOAL (registra a saída do caixa, com o cartão/conta usado). ' +
            'Use SEMPRE que o usuário disser que pagou algo de um projeto de obra com o dinheiro/cartão/conta pessoal ' +
            '(ex.: "paguei 140 de material da reforma pelo Itaú", "gastei 500 na obra da casa no cartão Nubank"). ' +
            'Para despesas puramente pessoais (mercado, lazer) use create_expense normal.',
          parameters: {
            type: 'object',
            properties: {
              obraProjectId: { type: 'string', description: 'Id do projeto da obra/aquisição (REFORMA/COMPRA/CASA/CARRO). Use list_projects para resolver pelo nome.' },
              pessoalProjectId: { type: 'string', description: 'Id do projeto PESSOAL (caixa). Opcional: se houver apenas um PESSOAL acessível, é resolvido automaticamente.' },
              valor: { type: 'number', description: 'Valor em REAIS (ex.: 140). Obrigatório.' },
              tipoDespesa: { type: 'string', description: 'Categoria da despesa (ex.: MATERIAL_CONSTRUCAO, MAO_DE_OBRA, OBRA_REFORMA, OUTROS). Use OUTROS se não tiver certeza.' },
              titulo: { type: 'string', description: 'Descrição curta (opcional).' },
              fornecedor: { type: 'string', description: 'Fornecedor/loja (ex.: "Obramax").' },
              data: { type: 'string', description: 'Data REAL da compra (competência) no formato YYYY-MM-DD. Default: hoje. Para cartão, o vencimento da fatura é derivado automaticamente desta data.' },
              quantidadeParcela: { type: 'integer', description: 'Número de parcelas quando a compra foi parcelada (ex.: "em 2x"/"duas parcelas" -> 2). Omita para à vista.' },
              creditCardId: { type: 'string', description: 'Cartão usado no pagamento (via list_payment_methods). Vai no espelho pessoal.' },
              bankAccountId: { type: 'string', description: 'Conta usada no pagamento (via list_payment_methods). Vai no espelho pessoal.' },
            },
            required: ['obraProjectId', 'valor'],
            additionalProperties: false,
          },
        },
        run: async (ctx, args) => {
          const obra = await this.resolveWritableProject(ctx, args['obraProjectId'], 'expenses');
          if (obra.type === 'PESSOAL') {
            return { error: 'O projeto da obra não pode ser PESSOAL. Para despesa pessoal use create_expense.' };
          }
          const pessoal = await this.resolvePessoalProject(ctx, args['pessoalProjectId']);

          const valor = this.parseMoney(args['valor']);
          if (valor == null) return { error: 'Informe um valor em reais maior que zero.' };

          const tipoDespesa = this.normalizeEnum(args['tipoDespesa'], ExpenseType, 'OUTROS');
          const data = this.optDate(args['data']);
          const titulo = this.optStr(args['titulo']);
          const fornecedor = this.optStr(args['fornecedor']);
          const creditCardId = await this.resolvePaymentRef(ctx, args['creditCardId'], 'card');
          const bankAccountId = await this.resolvePaymentRef(ctx, args['bankAccountId'], 'account');

          // Parcelamento (propriedade da compra): aplicado igual nos dois lados,
          // mantendo canônico e espelho consistentes. A data informada é a DATA
          // DA COMPRA (competência); o caixa deriva o vencimento da fatura do
          // cartão a partir dela.
          const parcelas = this.optInt(args['quantidadeParcela'], 2, 60);
          const formaPagamento = parcelas ? 'PARCELADO' : 'A_VISTA';
          const dateFields = parcelas
            ? { dataInicioParcela: data, quantidadeParcela: parcelas, dataCompra: data }
            : { dataPagamento: data, dataCompra: data };

          // 1) Canônico na obra (registro do projeto — sem meio de pagamento).
          const canonico = await this.expenses.create(ctx.tenantId, obra.id, {
            tipoDespesa,
            valor,
            quantidade: 1,
            formaPagamento,
            status: 'PAGO',
            titulo,
            fornecedor,
            ...dateFields,
          } as any);

          // 2) Espelho no PESSOAL (saída do caixa) vinculado ao canônico.
          //    Se falhar, desfaz o canônico para não deixar registro pela metade.
          let espelho;
          try {
            espelho = await this.expenses.create(ctx.tenantId, pessoal.id, {
              tipoDespesa,
              valor,
              quantidade: 1,
              formaPagamento,
              status: 'PAGO',
              titulo,
              fornecedor,
              ...dateFields,
              creditCardId,
              bankAccountId,
              linkedExpenseId: canonico.id,
            } as any);
          } catch (e) {
            await this.expenses.remove(ctx.tenantId, obra.id, canonico.id).catch(() => undefined);
            throw e;
          }

          return {
            ok: true,
            obra: {
              expenseId: canonico.id,
              projeto: obra.name,
              tipoDespesa,
              valorTotalCentavos: canonico.valorTotal,
              formaPagamento,
              quantidadeParcela: parcelas ?? null,
            },
            pessoal: {
              expenseId: espelho.id,
              projeto: pessoal.name,
              vinculadoA: canonico.id,
              cardLast4: espelho.cardLast4 ?? null,
              bankLast4: espelho.bankLast4 ?? null,
            },
            mensagem: `Registrado: despesa em "${obra.name}"${parcelas ? ` (${parcelas}x)` : ''} e espelho no caixa "${pessoal.name}" (sem duplicar no consolidado).`,
          };
        },
      },
    };
  }

  private clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  /**
   * Resolve e AUTORIZA o projeto-alvo de uma escrita. Garante:
   * - projeto existe no tenant;
   * - usuário tem acesso ao projeto (ACL por projeto);
   * - o tipo do projeto suporta o módulo (expenses/receipts);
   * - usuário tem o módulo liberado (salvo full-access).
   * Lança Error com mensagem amigável (capturada por execute()).
   */
  private async resolveWritableProject(
    ctx: ToolContext,
    rawProjectId: unknown,
    module: ModuleSlug,
  ): Promise<{ id: string; name: string; type: string }> {
    const projectId =
      (typeof rawProjectId === 'string' && rawProjectId.trim()) ||
      ctx.projectId ||
      '';
    if (!projectId) {
      throw new Error(
        'Não sei em qual projeto registrar. Use list_projects e peça ao usuário para escolher.',
      );
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    if (!project) throw new Error('Projeto não encontrado.');

    if (!userCanAccessProject(ctx.role, ctx.projectScope ?? undefined, project.id)) {
      throw new Error('Sem permissão para acessar este projeto.');
    }
    if (!projectTypeHasModule(project.type, module)) {
      throw new Error(
        `Projetos do tipo "${project.type}" não suportam ${module === 'receipts' ? 'recebimentos' : 'despesas'}.`,
      );
    }
    if (!isFullAccessRole(ctx.role)) {
      const mods = Array.isArray(ctx.allowedModules) ? ctx.allowedModules : [];
      if (!mods.includes(module)) {
        throw new Error(
          `Sem permissão para o módulo de ${module === 'receipts' ? 'recebimentos' : 'despesas'}.`,
        );
      }
    }
    return project;
  }

  /**
   * Resolve o projeto PESSOAL (caixa/fonte da verdade) para o espelho.
   * - Se rawId informado: valida que é PESSOAL, no tenant e acessível.
   * - Senão: se houver exatamente UM PESSOAL acessível, usa-o; se o projeto em
   *   foco for PESSOAL, usa-o; caso contrário, pede para especificar.
   */
  private async resolvePessoalProject(
    ctx: ToolContext,
    rawId: unknown,
  ): Promise<{ id: string; name: string; type: string }> {
    const scope = ctx.projectScope ?? null;
    const explicit = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : '';
    if (explicit) {
      const p = await this.prisma.project.findFirst({
        where: { id: explicit, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, name: true, type: true },
      });
      if (!p) throw new Error('Projeto pessoal não encontrado.');
      if (p.type !== 'PESSOAL') throw new Error('O projeto de caixa informado não é do tipo PESSOAL.');
      if (!userCanAccessProject(ctx.role, scope ?? undefined, p.id)) {
        throw new Error('Sem permissão para acessar o projeto pessoal.');
      }
      return p;
    }

    const pessoais = await this.prisma.project.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null, type: 'PESSOAL', ...(scope ? { id: { in: scope } } : {}) },
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: 'asc' },
    });
    if (pessoais.length === 0) {
      throw new Error('Não há projeto PESSOAL para registrar o caixa. Crie um projeto Pessoal primeiro.');
    }
    if (pessoais.length === 1) return pessoais[0]!;

    const focused = pessoais.find((p) => p.id === ctx.projectId);
    if (focused) return focused;
    const nomes = pessoais.map((p) => `"${p.name}"`).join(', ');
    throw new Error(
      `Há mais de um projeto Pessoal (${nomes}). Peça ao usuário para indicar em qual registrar (pessoalProjectId).`,
    );
  }

  /**
   * Converte valor em reais para número > 0, ou null se inválido.
   * Aceita number (JSON) e string em formato pt-BR ("1.234,56") ou
   * decimal simples ("250.50"). Heurística para string sem vírgula:
   * ponto seguido de 3 dígitos no fim = separador de milhar (5.000 -> 5000);
   * caso contrário o ponto é decimal (250.50 -> 250.5).
   */
  private parseMoney(value: unknown): number | null {
    let n: number;
    if (typeof value === 'number') {
      n = value;
    } else if (typeof value === 'string') {
      let s = value.trim().replace(/r\$/gi, '').replace(/\s/g, '');
      if (s.includes(',')) {
        s = s.replace(/\./g, '').replace(',', '.');
      } else if (/\.\d{3}$/.test(s) || (s.match(/\./g)?.length ?? 0) > 1) {
        s = s.replace(/\./g, '');
      }
      n = Number(s);
    } else {
      return null;
    }
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 100) / 100;
  }

  /** Inteiro opcional dentro de [min,max]; undefined se ausente/ inválido. */
  private optInt(value: unknown, min: number, max: number): number | undefined {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    const r = Math.round(n);
    if (r < min || r > max) return undefined;
    return r;
  }

  /**
   * Valida um id de cartão/conta para vínculo: precisa existir no tenant e
   * pertencer a um projeto acessível pelo usuário. Retorna o id ou undefined.
   */
  private async resolvePaymentRef(
    ctx: ToolContext,
    rawId: unknown,
    kind: 'card' | 'account',
  ): Promise<string | undefined> {
    const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : '';
    if (!id) return undefined;
    const row =
      kind === 'card'
        ? await this.prisma.creditCard.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { projectId: true },
          })
        : await this.prisma.bankAccount.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { projectId: true },
          });
    if (!row) {
      throw new Error(kind === 'card' ? 'Cartão não encontrado.' : 'Conta bancária não encontrada.');
    }
    if (!userCanAccessProject(ctx.role, ctx.projectScope ?? undefined, row.projectId)) {
      throw new Error('Sem permissão para usar este meio de pagamento.');
    }
    return id;
  }

  /**
   * Valida o alvo de um vínculo cross-project (linkedExpenseId): precisa existir
   * no tenant, ser de OUTRO projeto, e o usuário precisa acessar o projeto-alvo.
   * Retorna o id ou undefined.
   */
  private async resolveLinkedExpense(
    ctx: ToolContext,
    rawId: unknown,
    currentProjectId: string,
  ): Promise<string | undefined> {
    const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : '';
    if (!id) return undefined;
    const row = await this.prisma.expense.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      select: { projectId: true },
    });
    if (!row) throw new Error('Despesa para vínculo não encontrada.');
    if (row.projectId === currentProjectId) {
      throw new Error('O vínculo cross-project exige uma despesa de OUTRO projeto.');
    }
    if (!userCanAccessProject(ctx.role, ctx.projectScope ?? undefined, row.projectId)) {
      throw new Error('Sem permissão para vincular a essa despesa.');
    }
    return id;
  }

  private optStr(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /** Valida YYYY-MM-DD; retorna a string ou undefined. */
  private optDate(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const s = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : s;
  }

  private pickEnumStr(value: unknown, allowed: string[], fallback: string): string {
    if (typeof value === 'string') {
      const up = value.trim().toUpperCase();
      if (allowed.includes(up)) return up;
    }
    return fallback;
  }

  /** Normaliza para um valor do enum (case-insensitive); usa fallback se inválido. */
  private normalizeEnum(
    value: unknown,
    enumObj: Record<string, string>,
    fallback: string,
  ): string {
    const values = Object.values(enumObj);
    if (typeof value === 'string') {
      const up = value.trim().toUpperCase();
      if (values.includes(up)) return up;
    }
    return fallback;
  }
}
