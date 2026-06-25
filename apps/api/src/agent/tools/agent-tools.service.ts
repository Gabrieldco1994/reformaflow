import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantFinancialService } from '../../tenant-financial/tenant-financial.service';
import { ToolDef } from '../llm/llm.types';

export interface ToolContext {
  tenantId: string;
  /** Projeto em foco quando o chat é aberto dentro de um projeto (opcional). */
  projectId?: string | null;
  /** Escopo de projetos acessíveis (null = sem restrição). Aplica ACL por projeto. */
  projectScope?: string[] | null;
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
  ) {
    this.handlers = this.buildHandlers();
  }

  getToolDefs(): ToolDef[] {
    return Object.values(this.handlers).map((h) => h.def);
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
            'Total de despesas agrupado por categoria/tipo, somando todos os projetos. Valores em centavos.',
          parameters: noParams,
        },
        run: async (ctx) => ({ categorias: await this.financial.getByCategory(ctx.tenantId, ctx.projectScope ?? null) }),
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
    };
  }

  private clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
}
