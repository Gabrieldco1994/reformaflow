import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { MerchantClassifierService, type MerchantCategory } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';

const SUGGEST_MIN_LENGTH = 3;

export interface SuggestCategoryResponse {
  category: string | null;
  subcategory: string | null;
  confidence: number;
  source: 'AI' | 'MANUAL' | 'CACHE';
  suggestedTipoDespesa: string | null;
}

const NEUTRAL_SUGGESTION: SuggestCategoryResponse = {
  category: null,
  subcategory: null,
  confidence: 0,
  source: 'CACHE',
  suggestedTipoDespesa: null,
};

@Controller('merchant-categories')
@UseInterceptors(TenantInterceptor)
export class MerchantClassifierController {
  constructor(
    private readonly svc: MerchantClassifierService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query('q') q?: string,
    @Query('source') source?: string,
  ) {
    return this.prisma.merchantCategory.findMany({
      where: {
        OR: [{ tenantId }, { tenantId: null }], // regras do tenant + globais
        ...(q ? { merchantKey: { contains: q.toLowerCase() } } : {}),
        ...(source ? { source: source.toUpperCase() } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  @Post('classify')
  async classify(@CurrentTenant() tenantId: string, @Body() body: { merchants: string[] }) {
    const map = await this.svc.classifyBatch(body.merchants ?? [], tenantId);
    return Object.fromEntries(map);
  }

  @Post('override')
  override(
    @CurrentTenant() tenantId: string,
    @Body() body: { merchant: string; category: MerchantCategory; subcategory?: string },
  ) {
    return this.svc.setManual(body.merchant, body.category, body.subcategory ?? null, tenantId);
  }

  /**
   * Cria a regra "esse fornecedor é sempre dessa categoria".
   *
   * Nem todo tipo de despesa tem categoria de merchant equivalente (só ~10 dos
   * ~30 têm). Isso NÃO é erro: quem chama já mudou a categoria da despesa antes
   * de chegar aqui, e devolver 4xx transformava um sucesso parcial em "falhou"
   * na cara do usuário — a categoria mudava e a mensagem dizia que não. Sem
   * mapeamento, só não há regra a criar: `ruleCreated: false`.
   */
  @Post('confirm-rule')
  async confirmRule(
    @CurrentTenant() tenantId: string,
    @Body() body: { merchant: string; tipoDespesa: string },
  ) {
    const category = MerchantClassifierService.toMerchantCategory(body.tipoDespesa);
    if (!category) {
      return { merchantKey: '', category: null, ruleCreated: false };
    }
    const saved = await this.svc.setManual(body.merchant, category, null, tenantId);
    return { merchantKey: saved?.merchantKey ?? '', category, ruleCreated: true };
  }

  @Post('remove-rule')
  removeRule(@CurrentTenant() tenantId: string, @Body() body: { merchant: string }) {
    return this.svc.removeManual(body.merchant, tenantId);
  }

  /**
   * Promove um fornecedor a regra GLOBAL (vale para todos os tenants como
   * fallback). Só ADMIN. `role` é por-tenant (não superadmin de plataforma):
   * ponytail: admin de um tenant pode escrever o namespace global compartilhado —
   * aceitável no modelo atual; virar gate de plataforma se surgir multi-tenant real.
   */
  @Post('promote-global')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async promoteGlobal(
    @Body() body: { merchant: string; tipoDespesa?: string; category?: MerchantCategory },
  ) {
    const category =
      body.category ??
      (body.tipoDespesa ? MerchantClassifierService.toMerchantCategory(body.tipoDespesa) : null);
    if (!category) {
      return { merchantKey: '', category: null, ruleCreated: false };
    }
    const saved = await this.svc.promoteGlobal(body.merchant, category, null);
    return { merchantKey: saved?.merchantKey ?? '', category, ruleCreated: true };
  }

  /**
   * Sugestão de categoria para um único texto (ex.: título/fornecedor digitado no
   * form de despesa). Retorna resposta neutra sem custo (sem chamar classifyBatch)
   * quando o texto é curto demais para ser um sinal útil.
   */
  @Post('suggest')
  async suggest(
    @CurrentTenant() tenantId: string,
    @Body() body: { text: string },
  ): Promise<SuggestCategoryResponse> {
    const text = (body?.text ?? '').trim();
    if (text.length < SUGGEST_MIN_LENGTH) {
      return { ...NEUTRAL_SUGGESTION };
    }

    const map = await this.svc.classifyBatch([text], tenantId);
    const key = MerchantClassifierService.normalizeKey(text);
    const result = map.get(key);
    if (!result) {
      return { ...NEUTRAL_SUGGESTION };
    }

    // #582 PR-2: `category`/`confidence`/`source` seguem crus no payload (display).
    // `suggestedTipoDespesa` passa pela precedência/limiar de regra aprendida —
    // sem regra confiável, fica null e o form não pré-seleciona nada.
    const learned = await this.svc.resolveLearnedExpenseType(text, tenantId);

    return {
      category: result.category,
      subcategory: result.subcategory,
      confidence: result.confidence,
      source: result.source,
      suggestedTipoDespesa: learned.expenseType,
    };
  }
}
