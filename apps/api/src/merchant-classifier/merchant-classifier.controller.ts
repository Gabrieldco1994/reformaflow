import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MerchantClassifierService, type MerchantCategory } from './merchant-classifier.service';
import { MERCHANT_TO_EXPENSE_TYPE } from './merchant-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

const SUGGEST_MIN_LENGTH = 3;

export interface SuggestCategoryResponse {
  category: string | null;
  subcategory: string | null;
  confidence: number;
  source: 'REGEX' | 'AI' | 'MANUAL' | 'CACHE';
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
export class MerchantClassifierController {
  constructor(
    private readonly svc: MerchantClassifierService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Query('q') q?: string, @Query('source') source?: string) {
    return this.prisma.merchantCategory.findMany({
      where: {
        ...(q ? { merchantKey: { contains: q.toLowerCase() } } : {}),
        ...(source ? { source: source.toUpperCase() } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  @Post('classify')
  async classify(@Body() body: { merchants: string[] }) {
    const map = await this.svc.classifyBatch(body.merchants ?? []);
    return Object.fromEntries(map);
  }

  @Post('override')
  override(@Body() body: { merchant: string; category: MerchantCategory; subcategory?: string }) {
    return this.svc.setManual(body.merchant, body.category, body.subcategory ?? null);
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
  async confirmRule(@Body() body: { merchant: string; tipoDespesa: string }) {
    const category = MerchantClassifierService.toMerchantCategory(body.tipoDespesa);
    if (!category) {
      return { merchantKey: '', category: null, ruleCreated: false };
    }
    const saved = await this.svc.setManual(body.merchant, category, null);
    return { merchantKey: saved?.merchantKey ?? '', category, ruleCreated: true };
  }

  @Post('remove-rule')
  removeRule(@Body() body: { merchant: string }) {
    return this.svc.removeManual(body.merchant);
  }

  /**
   * Sugestão de categoria para um único texto (ex.: título/fornecedor digitado no
   * form de despesa). Retorna resposta neutra sem custo (sem chamar classifyBatch)
   * quando o texto é curto demais para ser um sinal útil.
   */
  @Post('suggest')
  async suggest(@Body() body: { text: string }): Promise<SuggestCategoryResponse> {
    const text = (body?.text ?? '').trim();
    if (text.length < SUGGEST_MIN_LENGTH) {
      return { ...NEUTRAL_SUGGESTION };
    }

    const map = await this.svc.classifyBatch([text]);
    const key = MerchantClassifierService.normalizeKey(text);
    const result = map.get(key);
    if (!result) {
      return { ...NEUTRAL_SUGGESTION };
    }

    return {
      category: result.category,
      subcategory: result.subcategory,
      confidence: result.confidence,
      source: result.source,
      suggestedTipoDespesa: MERCHANT_TO_EXPENSE_TYPE[result.category] ?? null,
    };
  }
}
