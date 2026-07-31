import { Injectable, Logger } from '@nestjs/common';
import { ExpenseType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';

export const MERCHANT_CATEGORIES = [
  'alimentação',
  'transporte',
  'assinaturas',
  'viagem',
  'saúde',
  'compras',
  'educação',
  'casa',
  'moradia',
  'servicos',
  'beleza',
  'pets',
  'impostos',
  'lazer',
  'investimentos',
  'transferência',
  'outros',
] as const;
export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

/**
 * Mapeamento categoria do classifier (IA/regex) → ExpenseType pessoal.
 * Única fonte da verdade — não duplicar em outros módulos (importar daqui).
 * Nota: "transferência" mapeia para TRANSFERENCIA_TED (não existe o valor
 * literal "TRANSFERENCIA" no enum ExpenseType).
 */
export const MERCHANT_TO_EXPENSE_TYPE: Record<MerchantCategory, ExpenseType> = {
  alimentação: ExpenseType.ALIMENTACAO,
  transporte: ExpenseType.TRANSPORTE,
  assinaturas: ExpenseType.ASSINATURAS,
  viagem: ExpenseType.LAZER,
  saúde: ExpenseType.SAUDE,
  compras: ExpenseType.OUTROS,
  educação: ExpenseType.EDUCACAO,
  casa: ExpenseType.MORADIA,
  moradia: ExpenseType.MORADIA,
  servicos: ExpenseType.OUTROS,
  beleza: ExpenseType.BELEZA,
  pets: ExpenseType.PETS,
  impostos: ExpenseType.OUTROS,
  lazer: ExpenseType.LAZER,
  investimentos: ExpenseType.OUTROS,
  transferência: ExpenseType.TRANSFERENCIA_TED,
  outros: ExpenseType.OUTROS,
};

const EXPENSE_TYPE_TO_MERCHANT_CATEGORY: Partial<Record<ExpenseType, MerchantCategory>> = {
  [ExpenseType.ALIMENTACAO]: 'alimentação',
  [ExpenseType.TRANSPORTE]: 'transporte',
  [ExpenseType.ASSINATURAS]: 'assinaturas',
  [ExpenseType.LAZER]: 'lazer',
  [ExpenseType.SAUDE]: 'saúde',
  [ExpenseType.EDUCACAO]: 'educação',
  [ExpenseType.MORADIA]: 'moradia',
  [ExpenseType.BELEZA]: 'beleza',
  [ExpenseType.PETS]: 'pets',
  [ExpenseType.TRANSFERENCIA_TED]: 'transferência',
};

export interface ClassifyResult {
  merchant: string;
  category: MerchantCategory;
  subcategory: string | null;
  source: 'REGEX' | 'AI' | 'MANUAL' | 'CACHE';
  confidence: number;
}

@Injectable()
export class MerchantClassifierService {
  private readonly logger = new Logger(MerchantClassifierService.name);
  private readonly apiKey = process.env['GEMINI_API_KEY'];
  private readonly model = 'gemini-2.5-flash';

  constructor(private readonly prisma: PrismaService) {}

  static normalizeKey(raw: string): string {
    if (!raw) return '';
    let s = raw.toLowerCase();
    s = s.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ');
    s = s.replace(/\b\d{4,}\b/g, ' ');
    s = s.replace(/[*•·.,;:|()\-_/\\]/g, ' ');
    s = s.replace(/\b(ltda|me|epp|sa|eireli|com|loja|filial)\b/g, ' ');
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    return s.slice(0, 80);
  }

  static isLikelyPixPessoaFisica(raw: string): boolean {
    const text = (raw ?? '').toUpperCase().trim();
    if (!text) return false;
    if (!/^PIX\s+TRANSF\b|^PIX\s+ENVIADO\b|^TED\b|^DOC\b/.test(text)) return false;
    if (/\b(LTDA|EIRELI|S\/A|SA\b|MEI|ME\b|EPP|MERCADO\s*PAGO|PAGSEGURO|STONE|CIELO)\b/.test(text)) {
      return false;
    }
    return true;
  }

  static toMerchantCategory(expenseType: string): MerchantCategory | null {
    return EXPENSE_TYPE_TO_MERCHANT_CATEGORY[expenseType as ExpenseType] ?? null;
  }

  /**
   * Resolve a regra de uma chave normalizada: tenta o tenant primeiro e só então
   * cai no global (`tenantId` null). Nunca cruza para regra de outro tenant.
   */
  private async lookup(key: string, tenantId: string) {
    const rows = await this.prisma.merchantCategory.findMany({
      where: { merchantKey: key, OR: [{ tenantId }, { tenantId: null }] },
    });
    return rows.find((r) => r.tenantId === tenantId) ?? rows.find((r) => r.tenantId === null) ?? null;
  }

  async fromCache(raw: string, tenantId: string): Promise<ClassifyResult | null> {
    const key = MerchantClassifierService.normalizeKey(raw);
    if (!key) return null;
    const row = await this.lookup(key, tenantId);
    if (!row) return null;
    return {
      merchant: raw,
      category: row.category as MerchantCategory,
      subcategory: row.subcategory,
      source: (row.source as ClassifyResult['source']) ?? 'CACHE',
      confidence: row.confidence,
    };
  }

  async manualExpenseType(raw: string, tenantId: string): Promise<ExpenseType | null> {
    const row = await this.fromCache(raw, tenantId);
    if (!row || row.source !== 'MANUAL') return null;
    const expenseType = MERCHANT_TO_EXPENSE_TYPE[row.category];
    if (!expenseType || expenseType === ExpenseType.OUTROS) return null;
    return expenseType;
  }

  /**
   * Classifica batch:
   *   1. Cache lookup (DB)
   *   2. Gemini para os faltantes (1 chamada)
   *   3. Persiste no cache
   */
  async classifyBatch(merchants: string[], tenantId: string): Promise<Map<string, ClassifyResult>> {
    const result = new Map<string, ClassifyResult>();
    if (!merchants.length) return result;

    const uniqueByKey = new Map<string, string>();
    for (const m of merchants) {
      const k = MerchantClassifierService.normalizeKey(m);
      if (k && !uniqueByKey.has(k)) uniqueByKey.set(k, m);
    }
    const keys = [...uniqueByKey.keys()];

    const cachedRows = await this.prisma.merchantCategory.findMany({
      where: { merchantKey: { in: keys }, OR: [{ tenantId }, { tenantId: null }] },
    });
    // tenant-first, global fallback por chave
    const cachedMap = new Map<string, (typeof cachedRows)[number]>();
    for (const row of cachedRows) {
      const cur = cachedMap.get(row.merchantKey);
      if (!cur || (cur.tenantId === null && row.tenantId === tenantId)) {
        cachedMap.set(row.merchantKey, row);
      }
    }

    const pending: { key: string; sample: string }[] = [];
    for (const [key, sample] of uniqueByKey) {
      const c = cachedMap.get(key);
      if (c) {
        result.set(key, {
          merchant: sample,
          category: c.category as MerchantCategory,
          subcategory: c.subcategory,
          source: (c.source as ClassifyResult['source']) ?? 'CACHE',
          confidence: c.confidence,
        });
      } else {
        pending.push({ key, sample });
      }
    }

    if (pending.length && this.apiKey) {
      // Paginação: chunk de 60 evita prompts gigantes e respostas truncadas
      const CHUNK = 60;
      try {
        for (let i = 0; i < pending.length; i += CHUNK) {
          const slice = pending.slice(i, i + CHUNK);
          const aiResults = await this.callGemini(slice.map((p) => p.sample));
          const ops = aiResults.slice(0, slice.length).map((r, j) => {
            const key = slice[j].key;
            const cat = (MERCHANT_CATEGORIES as readonly string[]).includes(r.category)
              ? r.category
              : 'outros';
            result.set(key, {
              merchant: slice[j].sample,
              category: cat as MerchantCategory,
              subcategory: r.subcategory ?? null,
              source: 'AI',
              confidence: r.confidence ?? 0.8,
            });
            return this.prisma.merchantCategory.upsert({
              where: { tenantId_merchantKey: { tenantId, merchantKey: key } },
              create: {
                tenantId,
                merchantKey: key,
                merchantSample: slice[j].sample.slice(0, 200),
                category: cat,
                subcategory: r.subcategory ?? null,
                source: 'AI',
                confidence: r.confidence ?? 0.8,
                aiResponse: JSON.stringify(r).slice(0, 1000),
              },
              update: {
                category: cat,
                subcategory: r.subcategory ?? null,
                source: 'AI',
                confidence: r.confidence ?? 0.8,
                aiResponse: JSON.stringify(r).slice(0, 1000),
              },
            });
          });
          if (ops.length) await this.prisma.$transaction(ops);
        }
      } catch (err) {
        this.logger.warn(`Gemini classify failed: ${(err as Error).message}`);
      }
    } else if (pending.length) {
      this.logger.debug(`No GEMINI_API_KEY — ${pending.length} merchants sem classificação`);
    }

    return result;
  }

  /**
   * Override manual (UI corrige). Persiste no cache do tenant com source=MANUAL e
   * confidence=1.0. Nunca toca regra global nem de outro tenant.
   */
  async setManual(
    raw: string,
    category: MerchantCategory,
    subcategory: string | null,
    tenantId: string,
  ) {
    const key = MerchantClassifierService.normalizeKey(raw);
    if (!key) return null;
    return this.prisma.merchantCategory.upsert({
      where: { tenantId_merchantKey: { tenantId, merchantKey: key } },
      create: {
        tenantId,
        merchantKey: key,
        merchantSample: raw.slice(0, 200),
        category,
        subcategory: subcategory ?? null,
        source: 'MANUAL',
        confidence: 1.0,
      },
      update: {
        category,
        subcategory: subcategory ?? null,
        source: 'MANUAL',
        confidence: 1.0,
      },
    });
  }

  /**
   * Promove uma regra a GLOBAL (`tenantId` null) — visível para todos os tenants
   * como fallback. Só ADMIN chega aqui (gate no controller). Substitui a global
   * anterior da mesma chave (upsert seria inseguro: null em unique composto no
   * SQLite não casa em findUnique).
   */
  async promoteGlobal(raw: string, category: MerchantCategory, subcategory?: string | null) {
    const key = MerchantClassifierService.normalizeKey(raw);
    if (!key) return null;
    const [, created] = await this.prisma.$transaction([
      this.prisma.merchantCategory.deleteMany({ where: { tenantId: null, merchantKey: key } }),
      this.prisma.merchantCategory.create({
        data: {
          tenantId: null,
          merchantKey: key,
          merchantSample: raw.slice(0, 200),
          category,
          subcategory: subcategory ?? null,
          source: 'MANUAL',
          confidence: 1.0,
        },
      }),
    ]);
    return created;
  }

  async removeManual(raw: string, tenantId: string): Promise<{ merchantKey: string; deleted: boolean }> {
    const key = MerchantClassifierService.normalizeKey(raw);
    if (!key) return { merchantKey: '', deleted: false };
    const deleted = await this.prisma.merchantCategory.deleteMany({
      where: { merchantKey: key, tenantId, source: 'MANUAL' },
    });
    return { merchantKey: key, deleted: deleted.count > 0 };
  }

  private async callGemini(merchants: string[]): Promise<
    Array<{ merchant: string; category: string; subcategory?: string; confidence?: number }>
  > {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const taxonomy = MERCHANT_CATEGORIES.join(', ');
    const prompt = `Você é um classificador de estabelecimentos brasileiros (extratos bancários e faturas de cartão).
Para cada item abaixo, identifique o ramo de atividade pelo nome e classifique numa destas categorias EXATAS (em pt-br com acentos):
${taxonomy}

Regras rápidas:
- alimentação: ifood, restaurante, padaria, supermercado, lanchonete, açougue.
- transporte: uber, 99, posto/combustível, estacionamento, pedágio, metrô, ônibus.
- assinaturas: netflix, spotify, apple, google, github, openai, software recorrente.
- viagem: cias aéreas, hotéis, booking, airbnb, aluguel de carro.
- saúde: farmácia, drogaria, hospital, clínica, laboratório, plano de saúde.
- compras: amazon, mercado livre, magalu, shopee, lojas roupa/eletrônicos.
- educação: escola, faculdade, curso, plataformas EAD.
- casa: material construção, móveis, decoração (leroy, tok stok, ikea).
- moradia: aluguel, condomínio, água, luz, gás, IPTU.
- servicos: encanador, eletricista, conserto, manutenção, advogado.
- beleza: cabeleireiro, salão, manicure, cosméticos.
- pets: petshop, veterinário, ração.
- impostos: tributos, DARF, multa, IPVA.
- lazer: cinema, shows, parques, jogos.
- investimentos: corretoras, B3, CDB.
- transferência: PIX TRANSF, PIX CARTAO, TED, DOC — transferências entre pessoas físicas (não consumo).
- outros: só se realmente não conseguir.

Dicas para extratos Itaú:
- "PAY <CODIGO> dd/mm" = pagamento via app Itaú. Códigos comuns: IFD/IFOOD=alimentação, UBR/UBER/99=transporte, RPP/RAPPI=alimentação. Para códigos desconhecidos, retorne "outros" com confidence baixa.
- "PIX QRS <NOME>" = pagamento via QR Code, geralmente comércio. Ex: ENEL DISTRI=moradia (luz), SABESP=moradia (água).
- "SISDEB / SISPAG <EMPRESA>" = débito/pagamento automático corporativo.
- "PIX TRANSF <NOME PF>" = transferência entre pessoas.

Devolva JSON ARRAY na MESMA ORDEM:
[{"merchant":"...","category":"...","subcategory":"breve","confidence":0.0-1.0}]

Itens:
${merchants.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';

    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
      const lastClose = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
      const fixed = lastClose > 0 ? text.slice(0, lastClose + 1) : '[]';
      try { parsed = JSON.parse(fixed); } catch { parsed = []; }
    }
    if (!Array.isArray(parsed)) parsed = [];
    return parsed as Array<{ merchant: string; category: string; subcategory?: string; confidence?: number }>;
  }
}
