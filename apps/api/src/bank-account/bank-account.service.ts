import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, INCLUDE_SOFT_DELETED } from '../prisma/prisma.service';
import { CreateBankAccountDto, UpdateBankAccountDto } from './dto/bank-account.dto';
import { parseBankStatementBuffers, type BankSourceHint } from './parsers';
import {
  assertRateioRequester,
  RateioRequester,
} from '../expense/rateio.types';

/** Normaliza a entrada (string legada, Buffer único ou array) para Buffer[]. */
function toBuffers(content: string | Buffer | Buffer[]): Buffer[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [Buffer.from(content, 'utf-8')];
  return [content];
}

/**
 * Detecta se um arquivo importado como EXTRATO parece, na verdade, ser uma
 * FATURA DE CARTÃO (Bug A: o extrato inverte o sinal — despesa do cartão vira
 * "recebimento" no caixa real). Não bloqueia: só sinaliza no preview para o
 * usuário decidir, igual ao restante do fluxo (mode=preview/commit, decisions[]).
 *
 * Três sinais, qualquer um já dispara:
 *  - cabeçalho exatamente "date,title,amount" (fatura Nubank, ver credit-card/parsers/csv.ts)
 *  - alguma transação com parcela detectada ("Parcela N/M" só existe em fatura)
 *  - >90% das linhas viram recebimento (isCredit) — também cobre bancos que
 *    exportam tudo positivo com coluna D/C (Bradesco/BB/Caixa)
 */
function detectCardInvoiceWarning(
  buffers: Buffer[],
  transactions: Array<{ amountCents: number; installmentTotal?: number }>,
): { code: 'looks_like_card_invoice'; message: string } | null {
  const headerLooksLikeCardInvoice = buffers.some((buf) => {
    const firstLine = buf
      .toString('utf-8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/, 1)[0]
      ?.trim()
      .toLowerCase();
    return firstLine === 'date,title,amount';
  });
  const hasInstallmentMarkers = transactions.some((t) => (t.installmentTotal ?? 0) > 1);
  const total = transactions.length;
  const creditRatio = total > 0 ? transactions.filter((t) => t.amountCents < 0).length / total : 0;

  if (!headerLooksLikeCardInvoice && !hasInstallmentMarkers && creditRatio <= 0.9) return null;
  return {
    code: 'looks_like_card_invoice',
    message:
      'Isso parece uma fatura de cartão, não um extrato bancário. Importar fatura como extrato inverte o sinal e faz despesas do cartão entrarem como recebimento no caixa. Confira antes de importar.',
  };
}
import type { NormalizedTx } from '../credit-card/parsers/types';
import { categorize } from '../credit-card/categorizer';
import {
  MerchantClassifierService,
  MERCHANT_TO_EXPENSE_TYPE,
} from '../merchant-classifier/merchant-classifier.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import {
  CardInvoiceSettlementService,
  type PreparedInvoiceSettlement,
  type SettleCard,
} from '../credit-card/card-invoice-settlement.service';
import {
  pickUniqueCardMatch,
  rankCardCandidates,
  type CardInvoiceCandidate,
  type CardWithEntries,
} from './card-invoice-match';
import { buildInstallments, isSinglePaymentForm, NEUTRAL_EXPENSE_TYPES } from '@reformaflow/domain';
import {
  CREDIT_CARD_MODULE,
  EXPENSE_MODULE,
  RECEIPT_MODULE,
  RECURRING_BILL_MODULE,
  resolveAccessibleProjectScope,
} from '../common/access-rules';
import { AMBIGUOUS_CARD_MESSAGE } from '../common/invoice-identity';

export interface BankImportDecision {
  externalId: string;
  action?: 'create' | 'skip' | 'link';
  linkToExpenseId?: string;
  linkToReceiptId?: string;
  overrides?: {
    titulo?: string;
    valorCents?: number;
    category?: string;
    /**
     * Cartão que esta linha quita, escolhido pelo usuário na tela de importação.
     * Manda mais que qualquer heurística: com ele o pagamento nasce com
     * `cardLast4` preenchido e a fatura é liquidada no mesmo commit.
     */
    cardLast4?: string;
    /**
     * (#574) Conta de destino da transferência, exigida quando o usuário
     * reclassifica explicitamente a linha para `category: 'MOVIMENTACAO_INTERNA'`.
     * Semântica por PRESENÇA da chave, não pelo valor:
     * - chave AUSENTE (nenhuma decisão explícita de destino) → rejeitado com
     *   BadRequestException; o usuário TEM que escolher.
     * - string (id de `BankAccount` cadastrada, mesmo tenant) → transferência
     *   interna de fato: a perna gerada por esta linha NÃO cria CashFlowEntry
     *   (soma-zero real com a perna espelho).
     * - `null` explícito → confirmação de que é resgate/entrada de fora do
     *   perímetro rastreado (não é conta cadastrada) → mantém o comportamento
     *   ATUAL (não zera).
     * Classificação AUTOMÁTICA (sem `category` no override, via `fastClassify`)
     * NUNCA passa por essa exigência — é comportamento pré-existente, fora do
     * escopo prospectivo desta issue.
     */
    transferToAccountId?: string | null;
  };
}

/** (#574) Mensagem de erro para decisão de reclassificação MOVIMENTACAO_INTERNA sem conta de destino explícita. */
export const INTERNAL_TRANSFER_ACCOUNT_REQUIRED_MESSAGE =
  'Reclassificar como Movimentação Interna exige escolher a conta de destino cadastrada, ou confirmar explicitamente que não é transferência entre suas contas.';

type SettlementClient = PrismaService | Prisma.TransactionClient;

interface MatchedSettlementCard extends SettleCard {
  nickname: string;
}

interface PreparedBankCardPayment {
  isCardPayment: boolean;
  matchedCard: MatchedSettlementCard | null;
  settlement: PreparedInvoiceSettlement | null;
}

interface BankImportCreationResult {
  inserted: boolean;
  receiptInserted: boolean;
  cardPayment: boolean;
  unlinkedCardPayment: boolean;
  expenseId?: string;
  receiptId?: string;
}

interface BankImportPreparedRow {
  transaction: NormalizedTx;
  categoryOverride: string | undefined;
  cardOverride: string | null;
  /** (#574) presente somente quando `categoryOverride === 'MOVIMENTACAO_INTERNA'`. */
  internalTransferAccountId: string | null | undefined;
}

interface BankCardPaymentPreflightState {
  row: BankImportPreparedRow;
  cardPaymentInfo: { isCardPayment: boolean; last4: string | null };
  isCardPayment: boolean;
  matchedCard: MatchedSettlementCard | null;
  needsValueMatch: boolean;
}

// Mapeamento categoria → ExpenseType pessoal — fonte única em merchant-classifier.service.ts.
const PESSOAL_CATEGORY_MAP: Record<string, string> = MERCHANT_TO_EXPENSE_TYPE;
const IMPORT_NOT_FOUND_MESSAGE = 'Importação não encontrada';
const CARD_PAYMENT_PREFLIGHT_MISSING_MESSAGE =
  'Pré-validação de pagamento de fatura ausente';
const CARD_NOT_FOUND_MESSAGE = 'Cartão não encontrado';

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
  if (/^PIX\s+TRANSF\b/.test(m)) return 'TRANSFERENCIA_TED';
  if (/^PIX\s+CARTAO\b/.test(m)) return 'TRANSFERENCIA_TED';
  if (/^TED\b/.test(m)) return 'TRANSFERENCIA_TED';
  if (/^DOC\b/.test(m)) return 'TRANSFERENCIA_TED';
  if (/\bNU\s+PAGAMENT|NUBANK\b/.test(m)) return 'TRANSFERENCIA_TED';
  // Tarifas bancárias e impostos financeiros
  if (/\bIOF\b|^TARIFA|^TAR\s|JUROS\s+ROTAT/.test(m)) return 'OUTROS';
  // Débitos automáticos de utilities/telco
  if (/\bDA\s+VIVO|\bVIVO-|\bCLARO\b|\bTIM\s|\bOI\s|\bNET\s|\bSKY\s|\bTIMO\b/.test(m)) return 'ASSINATURAS';
  if (/\bENEL\b|\bSABESP\b|\bELETROPAULO\b|\bCOMGAS\b|\bCEMIG\b|\bCOPEL\b|\bLIGHT\b/.test(m)) return 'MORADIA';
  if (/\bIPVA\b|\bIPTU\b|\bDARF\b|\bGPS\b|\bDETRAN\b/.test(m)) return 'OUTROS';
  // PAY xxx — códigos abreviados Itaú; alguns conhecidos.
  // ATENÇÃO: regex compara contra `m` que já é UPPERCASE — todos os tokens devem ser
  // em CAIXA ALTA (case-sensitive no JS), senão a regra não casa.
  // Alimentação (delivery, padaria, restaurante, conveniência, mercado, fast food)
  if (/^PAY\s+IFD\b|^PAY\s+IFOOD|^ON\s+IFD\b/.test(m)) return 'ALIMENTACAO';
  if (/^PAY\s+RAPPI|^PAY\s+RPP|^PAY\s+(99FOOD|UBER\s*EATS|KEETA)/.test(m)) return 'ALIMENTACAO';
  if (/^PAY\s+(DONA|BAR|REST|PIZZA|HAMB|BURGER|CAFE|DOC|PADAR|ACOUG|BANCA|BOTEC|NONNA|FORNE|DAPAD|FBQ|NA\s+JA|NAJAN|JIM\s+C|DLKNE|CONVE|OXXO|MC\s*DO|MULTI|DLK|MANIA|TIC\s+T|RIORE|MARCE|INOVA|SAFRA|KEZ|CB\b|MP\b|CASA|54624|MERCA|EMPOR|BITES|PIRAJ|MIX|RESER|RCV|LB\b|RODOS)/.test(m))
    return 'ALIMENTACAO';
  // Transporte (combustível, posto, ride, estacionamento, pedágio)
  if (/^PAY\s+UBR\b|^PAY\s+UBER/.test(m)) return 'TRANSPORTE';
  if (/^PAY\s+99\b/.test(m)) return 'TRANSPORTE';
  if (/^PAY\s+(POSTO|SHELL|IPIRANGA|PETROBR|ULTRA|BR\s|AUTOP|ESTAPAR|ZUL\s|PARKING|ESTAC)/.test(m)) return 'TRANSPORTE';
  // Saúde (farmácia, drogaria, hospital, academia, clínica)
  if (/^PAY\s+(FARMA|DROGAS|DROGA|HOSP|CLINIC|RAIA|PACHECO|DROGASIL|ACADE|SMARTFIT|GYM|FLEURY|DASA)/.test(m)) return 'SAUDE';
  // Casa/Reforma (material, construção, decoração)
  if (/^PAY\s+(LEROY|TOK\s*STOK|TELHA|OBRAMAX|IKEA|HOME\s*CENTER|MADEIRA|CASAS\s+BAHIA)/.test(m)) return 'MORADIA';
  // Compras gerais (varejo, e-commerce, shopping)
  if (/^PAY\s+(HAVAN|DECAT|LOJAS|SHOPP|RENNER|RIACH|MAGALU|AMERIC|AMAZON|MERC\s*LIVRE|SHEIN|SHOPEE|ZARA|HERING|NIKE|ADIDAS)/.test(m)) return 'COMPRAS_VAREJO';
  // Assinaturas/telco (operadora, streaming)
  if (/^PAY\s+(TIMO|VIVO|CLARO|TIM|OI|NETFLIX|SPOTIFY|DISNEY|HBO|GOOGLE|APPLE|MICROSOFT|YOUTUBE)/.test(m)) return 'ASSINATURAS';
  // Lazer/viagem/pets
  if (/^PAY\s+(LATAM|GOL|AZUL|DECOLAR|BOOKING|AIRBNB|HOTEL|CINEMA|TEATRO|INGRESSO|ZIG|CINE)/.test(m)) return 'LAZER';
  if (/^RSCSS\s+LAZY\s+DOG\b|^PAY\s+(PETZ|COBASI|PETSHOP|PET\s*SHOP|VETERIN|FOTO|CINEMA|CINE)|^RSCSS\s+CONVENIENCIA/.test(m)) return 'LAZER';
  // PIX vendor: marketplaces e contrapartes específicas
  if (/^PIX\s+QRS\s+(PIX\s+MARKETP|NU\s+PAGAMENT|MERCADO\s*PAGO|MERCADOPAG)/.test(m)) return 'TRANSFERENCIA_TED';
  return null;
}

/**
 * (#582 F3) Heurístico local de categoria para uma linha de débito SEM hit
 * confiável do classificador. Retorna `null` — não o literal `'OUTROS'` — quando
 * NEM `fastClassify` NEM o categorizador de keywords casaram: `categorize`
 * devolve `'outros'` só como fallback (nunca de um match real), então esse caso
 * não é uma classificação e não deve marcar `categoriaFonte: 'regex'`.
 */
export function localHeuristicCategory(merchant: string): string | null {
  const fast = fastClassify(merchant);
  if (fast) return fast;
  const cat = categorize(merchant);
  if (cat === 'outros') return null;
  return PESSOAL_CATEGORY_MAP[cat] ?? null;
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
    private readonly conciliacao: ConciliacaoService,
    private readonly cardSettlement: CardInvoiceSettlementService,
  ) {}

  // ─── CRUD contas ─────────────────────────────────────────

  async listAccounts(tenantId: string, projectId: string) {
    await this.ensureProject(tenantId, projectId);
    const accounts = await this.prisma.bankAccount.findMany({
      where: { tenantId, projectId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    if (accounts.length === 0) return accounts;

    const last4s = Array.from(new Set(accounts.map((account) => account.last4)));
    const [receipts, expenses] = await Promise.all([
      this.prisma.receipt.findMany({
        where: {
          tenantId,
          projectId,
          bankLast4: { in: last4s },
          status: { in: ['EM_CAIXA', 'PAGO'] },
          deletedAt: null,
        },
        select: { bankLast4: true, valor: true },
      }),
      this.prisma.expense.findMany({
        where: {
          tenantId,
          projectId,
          bankLast4: { in: last4s },
          status: 'PAGO',
          tipoDespesa: { notIn: Array.from(NEUTRAL_EXPENSE_TYPES) },
          deletedAt: null,
        },
        select: { bankLast4: true, valorTotal: true },
      }),
    ]);

    // Saldo exibido = recebimentos em caixa/pagos da conta − despesas pagas não neutras da conta.
    const balanceByLast4 = new Map<string, number>();
    for (const receipt of receipts) {
      if (!receipt.bankLast4) continue;
      balanceByLast4.set(receipt.bankLast4, (balanceByLast4.get(receipt.bankLast4) ?? 0) + receipt.valor);
    }
    for (const expense of expenses) {
      if (!expense.bankLast4) continue;
      balanceByLast4.set(expense.bankLast4, (balanceByLast4.get(expense.bankLast4) ?? 0) - expense.valorTotal);
    }

    return accounts.map((account) => ({
      ...account,
      balanceCents: balanceByLast4.get(account.last4) ?? 0,
    }));
  }

  /** Lista todas as contas do tenant (todos os projetos). Útil para vínculos cross-project. */
  async listAccountsTenant(tenantId: string, scope: string[] | null) {
    return this.prisma.bankAccount.findMany({
      where: { tenantId, deletedAt: null, ...(scope ? { projectId: { in: scope } } : {}) },
      orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }],
      include: { project: { select: { id: true, name: true, type: true } } },
    });
  }

  /**
   * B1a (#448): impede uma SEGUNDA conta ATIVA com o mesmo `last4` no mesmo
   * `{tenantId, projectId}` — contas soft-deletadas não contam. `excludeId`
   * exclui o próprio registro num update.
   *
   * ponytail: check-then-create dentro de UMA `$transaction` interativa só
   * fecha a corrida ENTRE `await`s de um único processo Node — sem UNIQUE no
   * schema, duas instâncias/workers da API ainda podem intercalar e ambos
   * passarem o check. Teto honesto: 1 processo. Upgrade definitivo é um
   * índice único parcial `(tenant_id, project_id, last4) WHERE deleted_at IS
   * NULL` via migration.
   */
  private async assertNoDuplicateAccount(
    tx: Prisma.TransactionClient,
    tenantId: string,
    projectId: string,
    last4: string,
    excludeId?: string,
  ): Promise<void> {
    const duplicate = await tx.bankAccount.findFirst({
      where: {
        tenantId,
        projectId,
        last4,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException('Já existe uma conta ativa com este final (últimos 4 dígitos) neste projeto.');
    }
  }

  async createAccount(tenantId: string, projectId: string, dto: CreateBankAccountDto) {
    await this.ensureProject(tenantId, projectId);
    const nickname = dto.nickname?.trim() || `${dto.institution} ****${dto.last4}`;
    const { openingBalanceDate, ...rest } = dto;
    const bankAccount = await this.prisma.$transaction(async (tx) => {
      await this.assertNoDuplicateAccount(tx, tenantId, projectId, dto.last4);
      return tx.bankAccount.create({
        data: {
          ...rest,
          nickname,
          tenantId,
          projectId,
          ...(openingBalanceDate ? { openingBalanceDate: new Date(openingBalanceDate) } : {}),
        },
      });
    });

    // Count receipts without account (origin='none') to offer linking
    const receiptsWithoutAccount = await this.prisma.receipt.count({
      where: {
        projectId,
        tenantId,
        accountId: null,
        origin: 'none',
        deletedAt: null,
      },
    });

    return {
      bankAccount,
      receiptsWithoutAccount,
    };
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
    await this.prisma.$transaction(async (tx) => {
      if (dto.last4 !== undefined) {
        await this.assertNoDuplicateAccount(tx, tenantId, projectId, dto.last4, id);
      }
      // Use updateMany with complete scope (id, tenantId, projectId, deletedAt: null)
      // to ensure atomicity and prevent TOCTOU race conditions.
      const result = await tx.bankAccount.updateMany({
        where: { id, tenantId, projectId, deletedAt: null },
        data,
      });
      if (result.count !== 1) {
        throw new NotFoundException('Conta bancária não encontrada ou foi modificada');
      }
    });
    return this.findAccount(tenantId, projectId, id);
  }

  async deleteAccount(tenantId: string, projectId: string, id: string) {
    await this.findAccount(tenantId, projectId, id);
    // Use deleteMany with complete scope (id, tenantId, projectId, deletedAt: null)
    // to ensure atomicity and prevent TOCTOU race conditions.
    // The soft-delete middleware will convert deleteMany to updateMany.
    const result = await this.prisma.bankAccount.deleteMany({
      where: { id, tenantId, projectId, deletedAt: null },
    });
    if (result.count !== 1) {
      throw new NotFoundException('Conta bancária não encontrada ou foi modificada');
    }
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
    fileContent: string | Buffer | Buffer[],
    fileName: string | undefined,
    source: BankSourceHint,
    password: string | undefined,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const account = await this.findAccount(tenantId, projectId, accountId);
    const buffers = toBuffers(fileContent);
    const parsed = await parseBankStatementBuffers(buffers, account.id, source, fileName, password);

    // Resolve a lente antes de qualquer `take`, total ou ranking. O snapshot
    // impede que um projeto seja revogado entre a resolução e a leitura.
    // Cada TIPO de candidato tem a sua própria lente: Expense exige `expenses`,
    // Receipt exige `receipts` e o cartão exige `creditCards` (#480 SEC-1) —
    // uma lista ampla compartilhada vazaria recurso de módulo não concedido.
    const cardWindow = this.cardEntryWindow(parsed.transactions);
    const { otherProjects, plannedExpenses, plannedReceipts, cardsWithEntries } =
      await this.prisma.$transaction(async (tx) => {
        const [expenseScope, receiptScope] = await Promise.all([
          resolveAccessibleProjectScope(
            tx,
            tenantId,
            requester.role,
            requester.allowedProjects,
            requester.allowedProjectTypes,
            requester.allowedModules ?? [],
            EXPENSE_MODULE,
          ),
          resolveAccessibleProjectScope(
            tx,
            tenantId,
            requester.role,
            requester.allowedProjects,
            requester.allowedProjectTypes,
            requester.allowedModules ?? [],
            RECEIPT_MODULE,
          ),
        ]);
        // Metadados de projeto só para a UNIÃO dos ids autorizados por recurso —
        // e cada um só é emitido junto de um candidato autorizado.
        const metadataScope =
          expenseScope === null || receiptScope === null
            ? null
            : [...new Set([...expenseScope, ...receiptScope])];
        const projects = metadataScope !== null && metadataScope.length === 0
          ? []
          : await tx.project.findMany({
              where: {
                tenantId,
                id: {
                  not: projectId,
                  ...(metadataScope !== null ? { in: metadataScope } : {}),
                },
                deletedAt: null,
              },
              select: { id: true, name: true, type: true },
            });
        const inScope = (scope: string[] | null) =>
          projects
            .map((project) => project.id)
            .filter((id) => (scope === null ? true : scope.includes(id)));
        const expenseProjectIds = inScope(expenseScope);
        const receiptProjectIds = inScope(receiptScope);
        const [expenses, receipts] = await Promise.all([
          expenseProjectIds.length > 0
            ? tx.expense.findMany({
                where: {
                  tenantId,
                  projectId: { in: expenseProjectIds },
                  OR: [
                    { status: 'PLANEJADO' },
                    { status: 'PAGO', quantidadeParcela: { gt: 1 } },
                  ],
                  linkedExpenseId: null,
                  deletedAt: null,
                },
                take: 1000,
                orderBy: { dataInicioParcela: 'desc' },
              })
            : [],
          receiptProjectIds.length > 0
            ? tx.receipt.findMany({
                where: {
                  tenantId,
                  projectId: { in: receiptProjectIds },
                  status: 'PREVISTO',
                  linkedReceiptId: null,
                  deletedAt: null,
                },
                take: 1000,
                orderBy: { data: 'desc' },
              })
            : [],
        ]);
        const cards = await this.loadCardsWithEntries(
          tenantId,
          cardWindow.from,
          cardWindow.to,
          requester,
          tx,
        );
        return {
          otherProjects: projects,
          plannedExpenses: expenses,
          plannedReceipts: receipts,
          cardsWithEntries: cards,
        };
      });
    const projectById = new Map(otherProjects.map((p) => [p.id, p]));
    const existing = await this.findExistingExternalIds(
      tenantId,
      projectId,
      parsed.transactions.map((t) => t.externalId),
    );

    function findExpenseMatches(tx: { date: Date; amountCents: number }) {
      if (plannedExpenses.length === 0) return [];
      const minDate = new Date(tx.date); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(tx.date); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const txCents = Math.abs(tx.amountCents);
      const tolerance = Math.max(100, Math.round(txCents * 0.05));
      const scored = plannedExpenses
        .map((p) => {
          const slices = buildInstallments({
            valorTotal: p.valorTotal,
            formaPagamento: p.formaPagamento,
            dataPagamento: p.dataPagamento,
            quantidadeParcela: p.quantidadeParcela,
            dataInicioParcela: p.dataInicioParcela,
            installmentDateOverrides: p.installmentDateOverrides,
          });
          const fallbackDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          const isInstallment = !isSinglePaymentForm(p.formaPagamento);
          const candidates = isInstallment
            ? slices.map((s, idx) => ({ idx, value: s.valor, date: s.data }))
            : [{ idx: -1, value: p.valorTotal, date: fallbackDate }];
          const valid = candidates.filter((c) => {
            if (Math.abs(c.value - txCents) > tolerance) return false;
            return c.date >= minDate && c.date <= maxDate;
          });
          if (valid.length === 0) return null;
          const best = valid.sort((a, b) => {
            const deltaA = Math.abs(a.value - txCents);
            const deltaB = Math.abs(b.value - txCents);
            if (deltaA !== deltaB) return deltaA - deltaB;
            return Math.abs(a.date.getTime() - tx.date.getTime()) - Math.abs(b.date.getTime() - tx.date.getTime());
          })[0];
          const proj = projectById.get(p.projectId);
          return {
            kind: 'expense' as const,
            expenseId: p.id,
            projectId: p.projectId,
            projectName: proj?.name ?? '',
            projectType: proj?.type ?? '',
            titulo: p.titulo,
            valorCents: best.value,
            data: best.date.toISOString().slice(0, 10),
            deltaCents: txCents - best.value,
            installmentCurrent: isInstallment && best.idx >= 0 ? best.idx + 1 : null,
            installmentTotal: isInstallment ? slices.length : null,
          };
        })
        .filter((m): m is NonNullable<typeof m> => !!m)
        .sort((a, b) => Math.abs(a.deltaCents) - Math.abs(b.deltaCents));
      return scored.slice(0, 5);
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

    const authorizedCardIds = cardsWithEntries
      .map((card) => card.id)
      .filter((id): id is string => Boolean(id));

    // #582 PR-4: uma única chamada de classificação para todos os merchants de
    // débito do lote (cache + Gemini, quando disponível) — nunca por transação.
    // `classifications` só carrega hits confiáveis (regra/ia); ausência de
    // chave = "sem hit confiável", tratado como heurística local abaixo.
    const debitMerchants = [...new Set(
      parsed.transactions.filter((t) => t.amountCents > 0).map((t) => t.merchant),
    )];
    const importClassification = await this.merchantClassifier.classifyForImport(
      debitMerchants,
      tenantId,
    );

    const preview = await Promise.all(parsed.transactions.map(async (tx) => {
      let isCardPay = tx.amountCents > 0 && detectCardPayment(tx.merchant).isCardPayment;
      // Match async por valor para "Pagamento PIX" / "PgConta" sem texto explícito
      if (!isCardPay && tx.amountCents > 0 && looksLikeOutboundTransfer(tx.merchant)) {
        const matched = await this.findCardPaymentByAmount(
          tenantId,
          tx.amountCents,
          tx.date,
          this.prisma,
          authorizedCardIds,
        );
        if (matched) isCardPay = true;
      }
      // Candidatos de fatura só interessam para pagamento de fatura. O usuário
      // escolhe na tela — o pagamento nunca deveria nascer sem cartão.
      const cardCandidates = isCardPay
        ? rankCardCandidates(cardsWithEntries, tx.amountCents, tx.date)
        : [];
      const detectedLast4 = detectCardPayment(tx.merchant).last4;
      const autoCard = isCardPay
        ? (
            (detectedLast4 &&
            cardsWithEntries.some((card) => card.last4 === detectedLast4)
              ? detectedLast4
              : null) ??
            pickUniqueCardMatch(cardCandidates)?.cardLast4 ??
            null
          )
        : null;
      const matches = tx.amountCents < 0
        ? findReceiptMatches(tx)         // crédito → match com Receipt PLANEJADO
        : findExpenseMatches(tx);        // débito → match com Expense PLANEJADO
      // #582 PR-4: hit confiável (regra=MANUAL, ia=AI>=limiar) vem do lote único
      // acima; sem hit, cai na heurística local existente ('regex'). Commit e
      // retroativo continuam no shim `manualExpenseType`, regra #16.
      const hit = tx.amountCents > 0
        ? importClassification.classifications.get(MerchantClassifierService.normalizeKey(tx.merchant))
        : undefined;
      const isPixPf = tx.amountCents > 0 && MerchantClassifierService.isLikelyPixPessoaFisica(tx.merchant);
      // (#582 F3) heurístico local — `null` quando nada casou, para não rotular
      // um fallback 'OUTROS' como classificação confiável ('regex').
      const localCat =
        tx.amountCents > 0 && !isCardPay && !isPixPf ? localHeuristicCategory(tx.merchant) : null;
      return {
        ...tx,
        date: tx.date.toISOString().slice(0, 10),
        duplicate: existing.has(tx.externalId),
        isCredit: tx.amountCents < 0,
        isCardPayment: isCardPay,
        suggestedCategory: tx.amountCents > 0
          ? (isCardPay
              ? 'PAGAMENTO_FATURA_CARTAO'
              : (hit
                  ? MERCHANT_TO_EXPENSE_TYPE[hit.category]
                  : (isPixPf
                    ? 'OUTROS'
                    : (localCat ?? 'OUTROS'))))
          : (fastClassify(tx.merchant) === 'MOVIMENTACAO_INTERNA' ? 'MOVIMENTACAO_INTERNA' : 'RECEITA'),
        categoriaFonte:
          tx.amountCents > 0 && !isCardPay
            ? (hit ? hit.source : (localCat != null ? 'regex' : null))
            : null,
        cardCandidates,
        suggestedCardLast4: autoCard,
        crossProjectMatches: matches,
      };
    }));

    const debits = parsed.transactions.filter((t) => t.amountCents > 0);
    const warning = detectCardInvoiceWarning(buffers, parsed.transactions);
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
      classificationStatus: importClassification.status,
      ...(warning ? { warning } : {}),
    };
  }

  async commitImport(
    tenantId: string,
    projectId: string,
    accountId: string,
    fileContent: string | Buffer | Buffer[],
    fileName: string | undefined,
    source: BankSourceHint,
    periodLabelOverride: string | undefined,
    password: string | undefined,
    decisions: BankImportDecision[] | undefined,
    createdByUserId: string | null,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const account = await this.findAccount(tenantId, projectId, accountId);
    const buffers = toBuffers(fileContent);
    const parsed = await parseBankStatementBuffers(buffers, account.id, source, fileName, password);
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
    const insertableDecisions = toInsert
      .map((transaction) => decisionByExt.get(transaction.externalId))
      .filter((decision): decision is BankImportDecision => Boolean(decision));
    const targetExpenseIds = [
      ...new Set(
        insertableDecisions
          .filter((decision) => decision.action === 'link')
          .map((decision) => decision.linkToExpenseId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const targetReceiptIds = [
      ...new Set(
        insertableDecisions
          .filter((decision) => decision.action === 'link')
          .map((decision) => decision.linkToReceiptId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const preparedRows: BankImportPreparedRow[] = toInsert.map((transaction) => {
      const decision = decisionByExt.get(transaction.externalId);
      return {
        transaction: {
          ...transaction,
          merchant: decision?.overrides?.titulo ?? transaction.merchant,
          amountCents: decision?.overrides?.valorCents ?? transaction.amountCents,
        },
        categoryOverride: decision?.overrides?.category,
        cardOverride: decision?.overrides?.cardLast4 ?? null,
        internalTransferAccountId:
          decision?.overrides?.category === 'MOVIMENTACAO_INTERNA'
            ? decision.overrides.transferToAccountId
            : undefined,
      };
    });

    // (#574) Preflight: reclassificação EXPLÍCITA para MOVIMENTACAO_INTERNA
    // exige que o usuário tenha decidido a conta de destino (cadastrada ou
    // "não é minha conta") ANTES de qualquer escrita. Classificação automática
    // (sem `overrides.category`) não passa por aqui — comportamento pré-existente.
    for (const row of preparedRows) {
      if (row.categoryOverride !== 'MOVIMENTACAO_INTERNA') continue;
      const decision = decisionByExt.get(row.transaction.externalId);
      const overrides = decision?.overrides ?? {};
      if (!('transferToAccountId' in overrides)) {
        throw new BadRequestException({
          message: INTERNAL_TRANSFER_ACCOUNT_REQUIRED_MESSAGE,
          externalId: row.transaction.externalId,
        });
      }
    }
    const registeredTransferAccountIds = [
      ...new Set(
        preparedRows
          .map((row) => row.internalTransferAccountId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (registeredTransferAccountIds.length > 0) {
      const found = await this.prisma.bankAccount.findMany({
        where: { id: { in: registeredTransferAccountIds }, tenantId, deletedAt: null },
        select: { id: true },
      });
      const foundIds = new Set(found.map((a) => a.id));
      const missing = registeredTransferAccountIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException({
          message: 'Conta de destino da transferência não encontrada.',
          accountIds: missing,
        });
      }
    }
    const userSkipped = (decisions ?? []).filter((d) => d?.action === 'skip' && !existingIds.has(d.externalId)).length;
    // Lista auditável do que foi ignorado como duplicata (mesma contagem de
    // `duplicated`, mas com as linhas). Sem isso, uma linha descartada some sem
    // rastro — foi assim que um salário de R$9.990,28 ficou invisível por semanas.
    const duplicatedItems = parsed.transactions
      .filter((t) => {
        const d = decisionByExt.get(t.externalId);
        if (d?.action === 'skip' && !existingIds.has(t.externalId)) return false; // skip do usuário, contado à parte
        return existingIds.has(t.externalId);
      })
      .map((t) => ({
        externalId: t.externalId,
        date: t.date,
        description: t.merchant,
        amountCents: t.amountCents,
        reason: 'duplicate' as const,
      }));
    const duplicated = parsed.transactions.length - toInsert.length - userSkipped;

    // Linhas que o PARSER recebeu mas não conseguiu virar lançamento (têm data
    // + descrição, não são saldo, mas sem valor legível). Categoria de perda
    // silenciosa distinta de duplicata — é a que escondeu um salário. Reportada
    // para auditoria; nunca sumindo sem rastro.
    const unparsedItems = (parsed.unparsedRows ?? []).map((r) => ({
      rowIndex: r.rowIndex,
      date: r.date,
      description: r.description,
      reason: r.reason,
    }));

    const debitsTotal = parsed.transactions
      .filter((t) => t.amountCents > 0)
      .reduce((s, t) => s + t.amountCents, 0);

    const createCore = async (client: Prisma.TransactionClient) => {
      await this.conciliacao.assertCanSettleTargets(
        client,
        { tenantId, targetExpenseIds },
        requester,
      );
      await this.conciliacao.assertCanMutateReceiptTargets(
        client,
        { tenantId, targetReceiptIds },
        requester,
      );
      // Preflight do lote inteiro: nenhuma escrita acontece antes de todos os
      // pagamentos de cartão e seus participantes passarem pela ACL.
      const preparedCardPayments = await this.prepareBankCardPayments(
        tenantId,
        preparedRows,
        requester,
        client,
      );
      const importRecord = await client.bankStatementImport.create({
        data: {
          tenantId,
          accountId: account.id,
          periodLabel,
          source: parsed.source,
          fileName: fileName?.slice(0, 200),
          fileSize: buffers.reduce((s, b) => s + b.length, 0),
          status: 'COMPLETED',
          inserted: toInsert.length,
          duplicated,
          totalAmountCents: debitsTotal,
        },
      });

      let inserted = 0;
      let receiptsInserted = 0;
      let cardPayments = 0;
      let unlinkedCardPayments = 0;
      let skipped = 0;
      const failedItems: Array<{
        date: string;
        description: string;
        amountCents: number;
        reason: 'error';
        message: string;
      }> = [];
      const createdRows: Array<{
        row: BankImportPreparedRow;
        decision: BankImportDecision | undefined;
        result: BankImportCreationResult;
      }> = [];

      for (const row of preparedRows) {
        const adjustedTx = row.transaction;
        const decision = decisionByExt.get(adjustedTx.externalId);
        const preparedCardPayment = preparedCardPayments.get(
          adjustedTx.externalId,
        );
        if (!preparedCardPayment) {
          throw new Error(CARD_PAYMENT_PREFLIGHT_MISSING_MESSAGE);
        }
        try {
          const result = await this.createExpenseFromTransaction(
            client,
            tenantId,
            projectId,
            account,
            adjustedTx,
            importRecord.id,
            row.categoryOverride,
            createdByUserId,
            preparedCardPayment,
            requester,
            row.internalTransferAccountId,
          );
          if (result.inserted) inserted++;
          if (result.receiptInserted) receiptsInserted++;
          if (result.cardPayment) cardPayments++;
          if (result.unlinkedCardPayment) unlinkedCardPayments++;
          createdRows.push({ row, decision, result });
        } catch (err) {
          // Preparação/aplicação de cartão nunca é best-effort: propaga para o
          // callback e desfaz o lote inteiro, inclusive pagamentos anteriores.
          if (preparedCardPayment.matchedCard) throw err;

          skipped++;
          failedItems.push({
            date:
              adjustedTx.date instanceof Date
                ? adjustedTx.date.toISOString().slice(0, 10)
                : String(adjustedTx.date),
            description: adjustedTx.merchant,
            amountCents: adjustedTx.amountCents,
            reason: 'error',
            message: (err as Error).message,
          });
          console.warn(
            `[bank-import] tx skipped (${adjustedTx.externalId.slice(0, 8)}):`,
            (err as Error).message,
          );
        }
      }

      return {
        importRecord,
        inserted,
        receiptsInserted,
        cardPayments,
        unlinkedCardPayments,
        skipped,
        failedItems,
        createdRows,
      };
    };
    const core = await this.prisma.$transaction(createCore);

    const {
      importRecord,
      inserted,
      receiptsInserted,
      cardPayments,
      unlinkedCardPayments,
      skipped,
      failedItems,
      createdRows,
    } = core;
    let linked = 0;
    for (const { row, decision, result } of createdRows) {
      if (decision?.action !== 'link') continue;
      const adjustedTx = row.transaction;
      try {
        if (decision.linkToExpenseId && result.expenseId) {
          const parcelaIndex = Math.max(
            0,
            (adjustedTx.installmentCurrent ?? 1) - 1,
          );
          await this.linkToExpense(
            tenantId,
            projectId,
            result.expenseId,
            decision.linkToExpenseId,
            {
              parcelaIndex,
              realValor: Math.abs(adjustedTx.amountCents),
            },
            requester,
          );
          linked++;
        } else if (decision.linkToReceiptId && result.receiptId) {
          await this.linkToReceipt(
            tenantId,
            projectId,
            result.receiptId,
            decision.linkToReceiptId,
            requester,
          );
          linked++;
        }
      } catch (linkErr) {
        console.warn(
          `[bank-import] link failed for ${adjustedTx.externalId.slice(0, 8)}:`,
          (linkErr as Error).message,
        );
      }
    }

    // Regras manuais confirmadas pelo usuário reaplicam no ingest para manter
    // consistência sem mexer em valor/caixa.
    const aiReclassified = await this.reclassifyImportedExpenses(tenantId, projectId, importRecord.id);

    // AC#7 (#582): override EXPLÍCITO de categoria numa linha efetivamente
    // importada (despesa criada, não duplicada/skip/erro) vira regra MANUAL
    // tenant-scoped. Efeito pós-persistência, fora da $transaction acima;
    // aprendizado reportado separado do resultado da importação.
    const learnEntries = createdRows
      .filter(
        ({ row, result }) =>
          Boolean(result.expenseId) &&
          Boolean(row.categoryOverride) &&
          row.categoryOverride !== 'MOVIMENTACAO_INTERNA' &&
          row.categoryOverride !== 'PAGAMENTO_FATURA_CARTAO',
      )
      .map(({ row }) => ({
        merchant: row.transaction.merchant,
        expenseType: row.categoryOverride as string,
      }));
    const {
      learned: rulesLearned,
      skippedNoMapping: rulesSkippedNoMapping,
      failed: rulesLearnFailed,
    } = await this.merchantClassifier.learnFromImportOverrides(learnEntries, tenantId);

    // ─── Propagação de recorrências p/ projetos CASA/CARRO ───
    // Utilities (Enel/Sabesp/Comgas/...) viram RecurringBill no projeto CASA do tenant.
    // IPVA vira RecurringBill no projeto CARRO.
    const recurrencesCreated = await this.propagateRecurrences(
      tenantId,
      importRecord.id,
      requester,
    );

    await this.prisma.bankStatementImport.update({
      where: { id: importRecord.id },
      data: {
        inserted,
        skipped: skipped + userSkipped,
        message: [
          receiptsInserted > 0 ? `${receiptsInserted} recebimento(s)` : null,
          cardPayments > 0 ? `${cardPayments} pagto(s) de cartão vinculado(s)` : null,
          unlinkedCardPayments > 0
            ? `${unlinkedCardPayments} pagto(s) de fatura SEM cartão identificado`
            : null,
          linked > 0 ? `${linked} vinculada(s) a planejado` : null,
          aiReclassified > 0 ? `${aiReclassified} categoria(s) por regra` : null,
          recurrencesCreated > 0 ? `${recurrencesCreated} recorrência(s) propagada(s)` : null,
          unparsedItems.length > 0 ? `${unparsedItems.length} linha(s) não reconhecida(s)` : null,
          failedItems.length > 0 ? `${failedItems.length} falha(s) ao importar` : null,
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
      duplicatedItems,
      unparsedItems,
      failedItems,
      receiptsInserted,
      cardPayments,
      unlinkedCardPayments,
      aiReclassified,
      recurrencesCreated,
      skipped: skipped + userSkipped,
      linked,
      rulesLearned,
      rulesSkippedNoMapping,
      rulesLearnFailed,
    };
  }

  // ─── Desfazer importação ─────────────────────────────────

  /**
   * Detalhe de um lote de importação de extrato: o que ele criou e o que será
   * revertido (ou não) se for desfeito. Alimenta o preview de impacto do
   * "Desfazer importação".
   *
   * #569 (hotfix fail-closed): qualquer lote que contenha um
   * `PAGAMENTO_FATURA_CARTAO` fica NÃO revertível como lote (`canUndo: false`).
   * O undo exato dessas liquidações continua aberto no issue #569 — aqui apenas
   * não arriscamos alterar outros pagamentos. Nenhum lookup de cartão, fatura ou
   * projeto externo, nenhuma reconstrução de `dueMonth`.
   */
  async getImportDetail(tenantId: string, projectId: string, accountId: string, importId: string) {
    await this.findAccount(tenantId, projectId, accountId);
    const importRecord = await this.prisma.bankStatementImport.findFirst({
      where: { id: importId, tenantId, accountId },
    });
    if (!importRecord) throw new NotFoundException('Importação não encontrada');

    const createdExpenses = await this.prisma.expense.findMany({
      where: { tenantId, importId, deletedAt: null, createdAt: { gte: importRecord.createdAt } },
      select: { id: true, titulo: true, valorTotal: true, status: true, tipoDespesa: true, cardLast4: true, fornecedor: true, linkedExpenseId: true },
      orderBy: { createdAt: 'asc' },
    });
    const createdReceipts = await this.prisma.receipt.findMany({
      where: { tenantId, importId, deletedAt: null, createdAt: { gte: importRecord.createdAt } },
      select: { id: true, descricao: true, valor: true, linkedReceiptId: true },
      orderBy: { createdAt: 'asc' },
    });
    const expenseIds = createdExpenses.map((e) => e.id);
    const receiptIds = createdReceipts.map((r) => r.id);

    const cashFlowEntries = (expenseIds.length || receiptIds.length)
      ? await this.prisma.cashFlowEntry.count({
          where: {
            deletedAt: null,
            OR: [
              ...(expenseIds.length ? [{ expenseId: { in: expenseIds } }] : []),
              ...(receiptIds.length ? [{ receiptId: { in: receiptIds } }] : []),
            ],
          },
        })
      : 0;
    const settlements = expenseIds.length
      ? await this.prisma.crossProjectSettlement.count({ where: { sourceExpenseId: { in: expenseIds } } })
      : 0;
    const rateios = expenseIds.length
      ? await this.prisma.rateioAllocation.count({ where: { sourceExpenseId: { in: expenseIds } } })
      : 0;

    // #569 (fail-closed): basta um pagamento de fatura LIGADO A ESTE IMPORT para
    // o undo em lote ficar bloqueado. A varredura ignora `createdAt` (cobre
    // despesa ADOTADA na dedup, criada antes do import) e inclui soft-deletadas
    // (cobre pagamento já removido por outro fluxo). Nada de lookup de
    // cartão/fatura/projeto.
    const cardInvoicePayments = await this.prisma.expense.findMany({
      where: {
        tenantId,
        importId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        deletedAt: INCLUDE_SOFT_DELETED,
      },
      select: { id: true },
    });
    const hasCardInvoicePayment = cardInvoicePayments.length > 0;

    // Recorrências propagadas (RecurringBill) — efeito IRREVERSÍVEL (upsert sem
    // snapshot). Contadas por best-effort re-rodando detectRecurrence.
    const recurrencesPropagated = createdExpenses.filter((e) => detectRecurrence(e.fornecedor || '') != null).length;

    return {
      importId: importRecord.id,
      periodLabel: importRecord.periodLabel,
      fileName: importRecord.fileName,
      createdAt: importRecord.createdAt,
      alreadyUndone: importRecord.deletedAt != null,
      totalAmountCents: createdExpenses.reduce((s, e) => s + e.valorTotal, 0),
      // #569: lote com pagamento de fatura não pode ser desfeito como lote.
      canUndo: importRecord.deletedAt != null ? true : !hasCardInvoicePayment,
      blocking: {
        cardInvoicePayments: cardInvoicePayments.length,
      },
      impact: {
        expenses: createdExpenses.length,
        receipts: createdReceipts.length,
        cashFlowEntries,
        crossProjectSettlements: settlements,
        rateioAllocations: rateios,
        crossProjectLinks: settlements + rateios + createdReceipts.filter((r) => r.linkedReceiptId != null).length,
        invoiceLiquidations: cardInvoicePayments.length,
      },
      irreversible: {
        recurrencesPropagated,
        notRevertibleInvoiceLiquidations: cardInvoicePayments.length,
      },
      expenses: createdExpenses.map((e) => ({
        id: e.id, titulo: e.titulo, valorTotal: e.valorTotal, status: e.status,
        cardPayment: e.tipoDespesa === 'PAGAMENTO_FATURA_CARTAO', linked: e.linkedExpenseId != null,
      })),
      receipts: createdReceipts.map((r) => ({
        id: r.id, descricao: r.descricao, valor: r.valor, linked: r.linkedReceiptId != null,
      })),
    };
  }

  /**
   * Desfaz um lote de importação de extrato bancário. Transacional e idempotente:
   *  - reverte a LIQUIDAÇÃO automática de fatura de cartão (`unsettleInvoice`) das
   *    faturas quitadas por pagamentos deste lote — as compras do cartão voltam a
   *    PLANEJADO (só para cartões com fechamento/vencimento; sem eles a liquidação
   *    usou fallback por "mais antiga em aberto", não revertível por vencimento e
   *    apenas reportada);
   *  - reverte vínculos cross-project (conciliação por parcela / rateio) das
   *    despesas do lote e limpa `linkedReceiptId` dos recebimentos do lote;
   *  - soft-delete das despesas, recebimentos e entradas de caixa criados;
   *  - soft-delete do próprio registro de importação.
   *
   * NÃO reverte a propagação de recorrências (`RecurringBill`), que é um upsert
   * sem snapshot — efeito irreversível reportado ao usuário no preview.
   */
  async undoImport(
    tenantId: string,
    projectId: string,
    accountId: string,
    importId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(
      requester,
      new NotFoundException(IMPORT_NOT_FOUND_MESSAGE),
    );
    await this.findAccount(tenantId, projectId, accountId);
    let importRecord = await this.prisma.bankStatementImport.findFirst({
      where: { id: importId, tenantId, accountId },
    });
    // Idempotência: um segundo `undoImport` do MESMO lote não pode estourar
    // 404 — o registro só está soft-deletado (o `$use` filtra `deletedAt: null`
    // por padrão, por isso a 2ª busca é explícita).
    if (!importRecord) {
      importRecord = await this.prisma.bankStatementImport.findFirst({
        where: { id: importId, tenantId, accountId, deletedAt: { not: null } },
      });
    }
    if (!importRecord) throw new NotFoundException(IMPORT_NOT_FOUND_MESSAGE);
    if (importRecord.deletedAt) {
      return {
        ok: true, alreadyUndone: true, removedExpenses: 0, removedReceipts: 0,
        revertedSettlements: 0, revertedInvoiceParcelas: 0, notRevertedInvoiceLiquidations: 0, unstamped: 0,
      };
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // TOCTOU (blocker 7): releitura de conta + import DENTRO da transação —
      // o preflight externo não basta.
      const accountTx = await tx.bankAccount.findFirst({
        where: { id: accountId, tenantId, projectId, deletedAt: null },
        select: { id: true },
      });
      if (!accountTx) throw new NotFoundException(IMPORT_NOT_FOUND_MESSAGE);
      const importTx = await tx.bankStatementImport.findFirst({
        where: { id: importId, tenantId, accountId },
      });
      if (!importTx || importTx.deletedAt) {
        throw new NotFoundException(IMPORT_NOT_FOUND_MESSAGE);
      }

      const created = await tx.expense.findMany({
        where: { tenantId, importId, deletedAt: null, createdAt: { gte: importRecord.createdAt } },
        select: {
          id: true,
          tipoDespesa: true,
        },
      });
      const receipts = await tx.receipt.findMany({
        where: { tenantId, importId, deletedAt: null, createdAt: { gte: importRecord.createdAt } },
        select: { id: true, linkedReceiptId: true },
      });
      const adopted = await tx.expense.findMany({
        where: { tenantId, importId, deletedAt: null, createdAt: { lt: importRecord.createdAt } },
        select: { id: true },
      });
      const createdIds = created.map((e) => e.id);
      const receiptIds = receipts.map((r) => r.id);
      const now = new Date();

      // ── #569 (hotfix fail-closed): um lote com QUALQUER `PAGAMENTO_FATURA_CARTAO`
      //    ligado ao import não pode ser desfeito automaticamente. Barrado AQUI,
      //    ANTES da primeira escrita: nenhuma despesa, recebimento, caixa, vínculo
      //    ou import é tocado. A varredura ignora `createdAt` (despesa adotada na
      //    dedup) e inclui soft-deletadas (pagamento já removido por outro fluxo).
      const cardInvoicePayments = await tx.expense.findMany({
        where: {
          tenantId,
          importId,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          deletedAt: INCLUDE_SOFT_DELETED,
        },
        select: { id: true },
      });
      if (cardInvoicePayments.length > 0) {
        throw new ConflictException(
          'Esta importação contém pagamento de fatura de cartão. Lotes com ' +
            'pagamento de fatura permanecem intactos por segurança e não podem ' +
            'ser desfeitos automaticamente.',
        );
      }
      // Sempre 0 daqui pra frente (o guard acima já barrou o único caso) —
      // mantido no retorno só para estabilidade do contrato da resposta.
      const notRevertedInvoiceLiquidations = 0;
      const revertedInvoiceParcelas = 0;

      await this.conciliacao.assertCanReverseSources(
        tx,
        { tenantId, sourceExpenseIds: createdIds },
        requester,
      );
      await this.conciliacao.assertCanMutateReceiptTargets(
        tx,
        {
          tenantId,
          targetReceiptIds: receipts.flatMap((receipt) =>
            receipt.linkedReceiptId ? [receipt.linkedReceiptId] : [],
          ),
        },
        requester,
      );

      // 1) Soft-delete das entradas de caixa e das despesas/recebimentos do lote.
      //    (ANTES da reversão de vínculos/faturas: falha posterior faz rollback
      //    destas deleções — garantia de atomicidade.)
      const cfOr = [
        ...(createdIds.length ? [{ expenseId: { in: createdIds } }] : []),
        ...(receiptIds.length ? [{ receiptId: { in: receiptIds } }] : []),
      ];
      if (cfOr.length) {
        await tx.cashFlowEntry.updateMany({ where: { deletedAt: null, OR: cfOr }, data: { deletedAt: now } });
      }
      if (createdIds.length) {
        await tx.expense.updateMany({ where: { id: { in: createdIds }, deletedAt: null }, data: { deletedAt: now } });
      }
      if (receiptIds.length) {
        await tx.receipt.updateMany({
          where: { id: { in: receiptIds }, deletedAt: null },
          data: { deletedAt: now, linkedReceiptId: null },
        });
      }

      // 2) Reverte vínculos cross-project de cada despesa-fonte do lote.
      let revertedSettlements = 0;
      for (const id of createdIds) {
        const res = await this.conciliacao.reverseSourceLinks(
          tx,
          { tenantId, sourceExpenseId: id },
          requester,
        );
        if (res.mode !== 'none') revertedSettlements += res.targets.length;
      }

      // 3) Liquidação automática de fatura: nunca há o que reverter aqui — o
      //    guard fail-closed (#569) já barrou qualquer lote com pagamento de
      //    fatura antes da primeira escrita.

      // 4) Despesas apenas ADOTADAS na dedup (se houver): remove o carimbo.
      for (const a of adopted) {
        await tx.expense.update({ where: { id: a.id }, data: { importId: null, externalId: null } });
      }

      // 5) Soft-delete do registro de importação.
      await tx.bankStatementImport.update({ where: { id: importId }, data: { deletedAt: now } });

      return {
        removedExpenses: createdIds.length,
        removedReceipts: receiptIds.length,
        revertedSettlements,
        revertedInvoiceParcelas,
        notRevertedInvoiceLiquidations,
        unstamped: adopted.length,
      };
    });

    return { ok: true, alreadyUndone: false, ...result };
  }

  /**
   * Reaplica apenas regras MANUAL em despesas OUTROS deste import.
   * Não auto-aplica IA/heurística aqui para preservar previsibilidade.
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

    let updated = 0;
    for (const c of candidates) {
      if (!c.fornecedor) continue;
      const manualType = await this.merchantClassifier.manualExpenseType(c.fornecedor, tenantId);
      if (!manualType) continue;
      await this.prisma.$transaction([
        this.prisma.expense.update({
          where: { id: c.id },
          data: { tipoDespesa: manualType },
        }),
        this.prisma.cashFlowEntry.updateMany({
          where: { expenseId: c.id },
          data: { categoria: manualType },
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
   * - Se não houver projeto CASA/CARRO **autorizado**, pula silenciosamente.
   *
   * ACL (#481): isto é ESCRITA (create E update) num projeto que NÃO é o da
   * importação. O destino sai do escopo do requisitante exigindo
   * `recurringBills` — o mesmo módulo que `RecurringBillController` exige na API
   * direta. Sem o módulo o escopo volta `[]` antes de qualquer leitura de
   * projeto, e a seleção do destino já nasce filtrada pelo escopo (não é uma
   * guarda aplicada depois de escolher "o primeiro CASA/CARRO do tenant", que
   * deixaria passar o caso de dois projetos onde só o segundo é acessível).
   * Um módulo NÃO relacionado suportado pelo mesmo tipo (CASA tem `maintenance`)
   * não libera o recurso — classe SEC-1 do #480. OWNER/ADMIN seguem irrestritos
   * no tenant. Sem destino autorizado o resultado é indistinguível de "o tenant
   * não tem projeto CASA/CARRO": nada escrito, nada revelado.
   */
  private async propagateRecurrences(
    tenantId: string,
    importId: string,
    requester: RateioRequester,
  ): Promise<number> {
    assertRateioRequester(requester);
    const expenses = await this.prisma.expense.findMany({
      where: { tenantId, importId, deletedAt: null },
      select: { id: true, fornecedor: true, valor: true, dataPagamento: true },
    });
    if (!expenses.length) return 0;

    const scope = await resolveAccessibleProjectScope(
      this.prisma,
      tenantId,
      requester.role,
      requester.allowedProjects,
      requester.allowedProjectTypes,
      requester.allowedModules ?? [],
      RECURRING_BILL_MODULE,
    );
    if (scope !== null && scope.length === 0) return 0;
    const inScope = scope !== null ? { id: { in: scope } } : {};

    // Acha projetos CASA/CARRO AUTORIZADOS do tenant (1x cada — primeiro encontrado)
    const houseProj = await this.prisma.project.findFirst({
      where: { tenantId, type: 'CASA', deletedAt: null, ...inScope },
      select: { id: true },
    });
    const carProj = await this.prisma.project.findFirst({
      where: { tenantId, type: 'CARRO', deletedAt: null, ...inScope },
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

  async suggestLinks(
    tenantId: string,
    projectId: string,
    accountId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
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

    const { otherProjects, planned } = await this.prisma.$transaction(async (tx) => {
      // Candidato é Expense: exige `expenses` no projeto candidato (#480 SEC-1).
      const scope = await resolveAccessibleProjectScope(
        tx,
        tenantId,
        requester.role,
        requester.allowedProjects,
        requester.allowedProjectTypes,
        requester.allowedModules ?? [],
        EXPENSE_MODULE,
      );
      const projects = await tx.project.findMany({
        where: {
          tenantId,
          id: {
            not: projectId,
            ...(scope !== null ? { in: scope } : {}),
          },
          deletedAt: null,
        },
        select: { id: true, name: true, type: true },
      });
      const projectIds = projects.map((project) => project.id);
      const expenses = projectIds.length > 0
        ? await tx.expense.findMany({
            where: {
              tenantId,
              projectId: { in: projectIds },
              OR: [
                { status: 'PLANEJADO' },
                { status: 'PAGO', quantidadeParcela: { gt: 1 } },
              ],
              deletedAt: null,
            },
            take: 500,
            orderBy: { dataInicioParcela: 'desc' },
          })
        : [];
      return { otherProjects: projects, planned: expenses };
    });
    if (otherProjects.length === 0) {
      return bankExpenses.map((e) => ({ expense: serializeExpense(e), suggestions: [] }));
    }

    const projectById = new Map(otherProjects.map((p) => [p.id, p]));

    return bankExpenses.map((e) => {
      const baseDate = e.dataPagamento ?? e.dataInicioParcela ?? e.createdAt;
      const minDate = new Date(baseDate); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(baseDate); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const tolerance = Math.max(100, Math.round(e.valorTotal * 0.05));

      const matches = planned
        .map((p) => {
          const slices = buildInstallments({
            valorTotal: p.valorTotal,
            formaPagamento: p.formaPagamento,
            dataPagamento: p.dataPagamento,
            quantidadeParcela: p.quantidadeParcela,
            dataInicioParcela: p.dataInicioParcela,
            installmentDateOverrides: p.installmentDateOverrides,
          });
          const fallbackDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          const isInstallment = !isSinglePaymentForm(p.formaPagamento);
          const candidates = isInstallment
            ? slices.map((s, idx) => ({ idx, value: s.valor, date: s.data }))
            : [{ idx: -1, value: p.valorTotal, date: fallbackDate }];
          const valid = candidates.filter((c) => {
            if (Math.abs(c.value - e.valorTotal) > tolerance) return false;
            return c.date >= minDate && c.date <= maxDate;
          });
          if (valid.length === 0) return null;
          const best = valid.sort((a, b) => {
            const deltaA = Math.abs(a.value - e.valorTotal);
            const deltaB = Math.abs(b.value - e.valorTotal);
            if (deltaA !== deltaB) return deltaA - deltaB;
            return Math.abs(a.date.getTime() - baseDate.getTime()) - Math.abs(b.date.getTime() - baseDate.getTime());
          })[0];
          return {
            expenseId: p.id,
            projectId: p.projectId,
            projectName: projectById.get(p.projectId)?.name ?? '',
            projectType: projectById.get(p.projectId)?.type ?? '',
            titulo: p.titulo,
            fornecedor: p.fornecedor,
            valor: best.value,
            data: best.date.toISOString(),
            deltaCents: e.valorTotal - best.value,
            installmentCurrent: isInstallment && best.idx >= 0 ? best.idx + 1 : null,
            installmentTotal: isInstallment ? slices.length : null,
          };
        })
        .filter((m): m is NonNullable<typeof m> => !!m)
        .sort((a, b) => Math.abs(a.deltaCents) - Math.abs(b.deltaCents))
        .slice(0, 5);

      return { expense: serializeExpense(e), suggestions: matches };
    });
  }

  /**
   * O requester é encaminhado ao preflight transacional do alvo.
   */
  async linkToExpense(
    tenantId: string,
    projectId: string,
    bankExpenseId: string,
    targetExpenseId: string,
    opts: { parcelaIndex?: number; realValor?: number } | undefined,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const source = await this.prisma.expense.findFirst({
      where: { id: bankExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa importada não encontrada');
    if (!source.bankLast4) throw new BadRequestException('Despesa não foi importada de conta bancária');

    const paymentDate = source.dataPagamento ?? source.dataInicioParcela ?? source.createdAt;
    const parcelaIndex = Math.max(0, opts?.parcelaIndex ?? 0);
    const realValor = opts?.realValor ?? source.valorTotal;

    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.settleTargetParcela(
        tx,
        {
          tenantId,
          sourceExpenseId: source.id,
          targetExpenseId,
          parcelaIndex,
          realValor,
        },
        requester,
      );
    });

    return { ok: true, sourceId: source.id, targetId: targetExpenseId, parcelaIndex, paymentDate };
  }

  async unlinkExpense(
    tenantId: string,
    projectId: string,
    bankExpenseId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester, new NotFoundException('Despesa não encontrada'));
    const source = await this.prisma.expense.findFirst({
      where: { id: bankExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.reverseSourceLinks(
        tx,
        { tenantId, sourceExpenseId: source.id },
        requester,
      );
    });
    return { ok: true };
  }

  /**
   * Sugere vínculos para recebimentos importados (no PESSOAL) a recebimentos
   * planejados em outros projetos (REFORMA/CASA/CARRO).
   * Critério: mesmo tenant e projeto candidato dentro do escopo autorizado do
   * solicitante; valor ≈ (±5%), data ±10 dias, status PREVISTO.
   */
  async suggestReceiptLinks(
    tenantId: string,
    projectId: string,
    accountId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
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

    const { otherProjects, planned } = await this.prisma.$transaction(async (tx) => {
      // Candidato é Receipt: exige `receipts` no projeto candidato (#480 SEC-1).
      const scope = await resolveAccessibleProjectScope(
        tx,
        tenantId,
        requester.role,
        requester.allowedProjects,
        requester.allowedProjectTypes,
        requester.allowedModules ?? [],
        RECEIPT_MODULE,
      );
      const projects = await tx.project.findMany({
        where: {
          tenantId,
          id: {
            not: projectId,
            ...(scope !== null ? { in: scope } : {}),
          },
          deletedAt: null,
        },
        select: { id: true, name: true, type: true },
      });
      const projectIds = projects.map((project) => project.id);
      const receipts = projectIds.length > 0
        ? await tx.receipt.findMany({
            where: {
              tenantId,
              projectId: { in: projectIds },
              status: 'PREVISTO',
              deletedAt: null,
            },
            take: 500,
            orderBy: { data: 'desc' },
          })
        : [];
      return { otherProjects: projects, planned: receipts };
    });
    if (otherProjects.length === 0) {
      return bankReceipts.map((r) => ({ receipt: serializeReceipt(r), suggestions: [] }));
    }

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
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const result = await this.prisma.$transaction(async (tx) => {
      const source = await tx.receipt.findFirst({
        where: { id: bankReceiptId, tenantId, projectId, deletedAt: null },
      });
      if (!source) throw new NotFoundException('Recebimento importado não encontrado');
      if (!source.bankLast4) {
        throw new BadRequestException('Recebimento não foi importado de conta bancária');
      }
      await this.conciliacao.assertCanMutateReceiptTargets(
        tx,
        { tenantId, targetReceiptIds: [targetReceiptId] },
        requester,
      );
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

      return { sourceId: source.id, targetId: target.id };
    });

    return { ok: true, sourceId: result.sourceId, targetId: result.targetId };
  }

  /**
   * Desfaz o link entre um recebimento importado e o alvo.
   * NÃO reverte o status do alvo (pode ter sido marcado EM_CAIXA por outro motivo).
   */
  async unlinkReceipt(
    tenantId: string,
    projectId: string,
    bankReceiptId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester, new NotFoundException('Recebimento não encontrado'));
    return this.prisma.$transaction(async (tx) => {
      const source = await tx.receipt.findFirst({
        where: { id: bankReceiptId, tenantId, projectId, deletedAt: null },
      });
      if (!source) throw new NotFoundException('Recebimento não encontrado');
      if (!source.linkedReceiptId) return { ok: true, alreadyUnlinked: true };
      await this.conciliacao.assertCanMutateReceiptTargets(
        tx,
        { tenantId, targetReceiptIds: [source.linkedReceiptId] },
        requester,
      );
      await tx.receipt.update({
        where: { id: source.id },
        data: { linkedReceiptId: null },
      });
      return { ok: true };
    });
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
    // $queryRaw (não findMany) de propósito: findMany passa pelo middleware de
    // soft-delete (prisma.service.ts) que força deletedAt=null, então uma linha
    // que o usuário excluiu deixaria de "existir" pro importador e reimportar o
    // mesmo extrato a recriaria. O check de duplicidade precisa enxergar
    // deletadas também — exclusão é definitiva, não "esqueça que já importei".
    const [expenses, receipts] = await Promise.all([
      this.prisma.$queryRaw<{ external_id: string }[]>`
        SELECT external_id FROM expenses
        WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          AND external_id IN (${Prisma.join(ids)})
      `,
      this.prisma.$queryRaw<{ external_id: string }[]>`
        SELECT external_id FROM receipts
        WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          AND external_id IN (${Prisma.join(ids)})
      `,
    ]);
    const set = new Set<string>();
    for (const r of expenses) if (r.external_id) set.add(r.external_id);
    for (const r of receipts) if (r.external_id) set.add(r.external_id);
    return set;
  }

  /**
   * Resolve e prepara todos os pagamentos de cartão antes da criação do lote.
   * A preparação é somente leitura; qualquer falha de ACL encerra o commit sem
   * `BankStatementImport`, Expense, Receipt ou CashFlowEntry novos.
   *
   * Linhas que exigem casamento por valor autorizam primeiro todos os cartões e
   * todas as compras que podem disputar o ranking. Só depois os totais são
   * carregados por `loadCardsWithEntries`.
   */
  private async prepareBankCardPayments(
    tenantId: string,
    rows: BankImportPreparedRow[],
    requester: RateioRequester,
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, PreparedBankCardPayment>> {
    if (rows.length === 0) return new Map();

    // Preflight de pagamento de fatura: o recurso é o CARTÃO (#480 SEC-1).
    const scope = await resolveAccessibleProjectScope(
      tx,
      tenantId,
      requester.role,
      requester.allowedProjects,
      requester.allowedProjectTypes,
      requester.allowedModules ?? [],
      CREDIT_CARD_MODULE,
    );
    const accessibleCards = await tx.creditCard.findMany({
      where: {
        tenantId,
        deletedAt: null,
        project: { deletedAt: null },
        ...(scope !== null ? { projectId: { in: scope } } : {}),
      },
      select: {
        id: true,
        projectId: true,
        last4: true,
        nickname: true,
        brand: true,
        closingDay: true,
        dueDay: true,
      },
    });
    const cardsByLast4 = new Map<string, typeof accessibleCards>();
    for (const card of accessibleCards) {
      const group = cardsByLast4.get(card.last4) ?? [];
      group.push(card);
      cardsByLast4.set(card.last4, group);
    }

    const states: BankCardPaymentPreflightState[] = [];
    for (const row of rows) {
      const cardPaymentInfo = detectCardPayment(row.transaction.merchant);
      const state: BankCardPaymentPreflightState = {
        row,
        cardPaymentInfo,
        isCardPayment: cardPaymentInfo.isCardPayment,
        matchedCard: null,
        needsValueMatch: false,
      };
      states.push(state);

      // Créditos viram Receipt antes de qualquer classificação de cartão.
      if (row.transaction.amountCents < 0) continue;

      const hasCardOverride =
        row.cardOverride &&
        (!row.categoryOverride ||
          row.categoryOverride === 'PAGAMENTO_FATURA_CARTAO');
      if (hasCardOverride) {
        const matches = cardsByLast4.get(row.cardOverride as string) ?? [];
        if (matches.length === 0) {
          throw new NotFoundException(CARD_NOT_FOUND_MESSAGE);
        }
        if (matches.length > 1) {
          throw new ConflictException(AMBIGUOUS_CARD_MESSAGE);
        }
        state.matchedCard = matches[0];
        state.isCardPayment = true;
        continue;
      }

      if (state.isCardPayment) {
        if (cardPaymentInfo.last4) {
          const matches = cardsByLast4.get(cardPaymentInfo.last4) ?? [];
          if (matches.length === 1) state.matchedCard = matches[0];
          // Duplicidade acessível é ambígua e jamais cai em outro auto-match.
          if (matches.length > 1) continue;
        }
        state.needsValueMatch = !state.matchedCard;
        continue;
      }

      if (
        looksLikeOutboundTransfer(row.transaction.merchant) &&
        !row.categoryOverride
      ) {
        state.needsValueMatch = true;
      }
    }

    const valueMatchStates = states.filter((state) => state.needsValueMatch);
    let cardsWithEntries: CardWithEntries[] = [];
    if (valueMatchStates.length > 0) {
      const probe = valueMatchStates[0].row.transaction;
      const unambiguousCards = [...cardsByLast4.values()]
        .filter((group) => group.length === 1)
        .map(([card]) => card);
      const authorizedCards: typeof unambiguousCards = [];

      // O ranking por valor pode considerar qualquer cartão ativo. Cada um
      // precisa passar pelo mesmo preflight de settlement antes dessa leitura.
      for (const card of unambiguousCards) {
        try {
          await this.cardSettlement.prepareSettleInvoice({
            tenantId,
            card,
            amountCents: probe.amountCents,
            paymentDate: probe.date,
            tx,
            requester,
            requiredModule: CREDIT_CARD_MODULE,
          });
          authorizedCards.push(card);
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error;
        }
      }

      const cardWindow = this.cardEntryWindow(
        valueMatchStates.map((state) => state.row.transaction),
      );
      cardsWithEntries = await this.loadCardsWithEntries(
        tenantId,
        cardWindow.from,
        cardWindow.to,
        requester,
        tx,
        authorizedCards.map((card) => ({
          id: card.id,
          projectId: card.projectId,
          last4: card.last4,
          nickname: card.nickname?.trim() || `${card.brand} ••${card.last4}`,
          closingDay: card.closingDay,
          dueDay: card.dueDay,
        })),
      );
      const authorizedCardIds = authorizedCards.map((card) => card.id);

      for (const state of valueMatchStates) {
        const transaction = state.row.transaction;
        if (state.cardPaymentInfo.isCardPayment) {
          state.matchedCard = await this.findMatchingCreditCard(
            tenantId,
            transaction.amountCents,
            transaction.date,
            state.cardPaymentInfo.last4,
            rankCardCandidates(
              cardsWithEntries,
              Math.abs(transaction.amountCents),
              transaction.date,
            ),
            tx,
            authorizedCardIds,
          );
        } else {
          state.matchedCard = await this.findCardPaymentByAmount(
            tenantId,
            transaction.amountCents,
            transaction.date,
            tx,
            authorizedCardIds,
          );
          if (state.matchedCard) state.isCardPayment = true;
        }
      }
    }

    const prepared = new Map<string, PreparedBankCardPayment>();
    for (const state of states) {
      const transaction = state.row.transaction;
      const settlement = state.matchedCard
        ? await this.cardSettlement.prepareSettleInvoice({
            tenantId,
            card: state.matchedCard,
            amountCents: transaction.amountCents,
            paymentDate: transaction.date,
            tx,
            requester,
            requiredModule: CREDIT_CARD_MODULE,
          })
        : null;
      prepared.set(transaction.externalId, {
        isCardPayment: state.isCardPayment,
        matchedCard: state.matchedCard,
        settlement,
      });
    }

    return prepared;
  }

  /**
   * Cria Expense (débito) ou Receipt (crédito) a partir de uma transação de extrato.
   * - amountCents > 0 = débito → Expense (PAGO) + CashFlowEntry DESPESA
   * - amountCents < 0 = crédito → Receipt (EM_CAIXA) + CashFlowEntry RECEBIMENTO
   */
  private async createExpenseFromTransaction(
    client: Prisma.TransactionClient,
    tenantId: string,
    projectId: string,
    account: { id: string; nickname: string; last4: string; institution: string },
    tx: NormalizedTx,
    importId: string,
    categoryOverride: string | undefined,
    createdByUserId: string | null,
    preparedCardPayment: PreparedBankCardPayment,
    requester: RateioRequester,
    /**
     * (#574) Presente (string ou null) SOMENTE quando o usuário reclassificou
     * explicitamente esta linha para MOVIMENTACAO_INTERNA na decisão de
     * importação. `undefined` = classificação automática, comportamento
     * inalterado (default histórico). String = conta cadastrada validada no
     * preflight de `commitImport` → perna neutra (soma-zero). `null` = usuário
     * confirmou que NÃO é conta cadastrada → mantém o comportamento atual.
     */
    internalTransferAccountId?: string | null,
  ): Promise<BankImportCreationResult> {
    if (tx.amountCents < 0) {
      const receiptAmount = -tx.amountCents;
      // Movimentação interna (resgate de aplicação/cofrinho etc.) entra como
      // crédito. Por padrão vira Receipt RESGATE e GERA CashFlowEntry
      // RECEBIMENTO normalmente (dinheiro de fora do perímetro rastreado).
      // (#574) EXCEÇÃO prospectiva: quando o usuário reclassifica esta linha
      // explicitamente e escolhe uma `BankAccount` CADASTRADA como destino da
      // transferência (`internalTransferAccountId` string), esta perna passa a
      // ser NEUTRA (sem CashFlowEntry) — espelha a perna de DÉBITO abaixo, que
      // já é neutra por padrão, produzindo soma-zero real na transferência.
      // categoryOverride do usuário tem prioridade sobre o auto-detect.
      const isInternalMov = categoryOverride === 'MOVIMENTACAO_INTERNA'
        || (!categoryOverride && fastClassify(tx.merchant) === 'MOVIMENTACAO_INTERNA');
      if (isInternalMov) {
        const isRegisteredTransfer =
          typeof internalTransferAccountId === 'string' && internalTransferAccountId.length > 0;
        // Resgate/movimentação interna entra como CRÉDITO → é ENTRADA (dinheiro
        // voltando da aplicação). Vira Receipt RESGATE (preserva a direção, em
        // linha com o consolidado financeiro). Antes virava Expense, o que
        // invertia o sinal do resgate.
        const receipt = await client.receipt.create({
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
        if (!isRegisteredTransfer) {
          await client.cashFlowEntry.create({
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
        }
        return { inserted: false, receiptInserted: true, cardPayment: false, unlinkedCardPayment: false, receiptId: receipt.id };
      }
      const tipoReceipt = classifyCreditType(tx.merchant);
      const receipt = await client.receipt.create({
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
      await client.cashFlowEntry.create({
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
      return { inserted: false, receiptInserted: true, cardPayment: false, unlinkedCardPayment: false, receiptId: receipt.id };
    }

    // ─── Pagamento de fatura pré-validado antes da criação do lote ─────
    const cardPaymentInfo = detectCardPayment(tx.merchant);
    const { isCardPayment, matchedCard, settlement } = preparedCardPayment;
    if (isCardPayment) {
      if (matchedCard) {
        if (!settlement) throw new Error(CARD_PAYMENT_PREFLIGHT_MISSING_MESSAGE);
        const currentSettlement = await this.cardSettlement.prepareSettleInvoice({
          tenantId,
          card: matchedCard,
          amountCents: tx.amountCents,
          paymentDate: tx.date,
          tx: client,
          requester,
          requiredModule: CREDIT_CARD_MODULE,
        });
        const e = await this.createCardPaymentExpense(
          client,
          tenantId,
          projectId,
          account,
          tx,
          importId,
          createdByUserId,
          matchedCard,
          cardPaymentInfo.last4,
        );
        await this.cardSettlement.applyPreparedSettlement(client, currentSettlement);
        return {
          inserted: false,
          receiptInserted: false,
          cardPayment: true,
          unlinkedCardPayment: false,
          expenseId: e.id,
        };
      }

      const e = await this.createCardPaymentExpense(
        client,
        tenantId,
        projectId,
        account,
        tx,
        importId,
        createdByUserId,
        null,
        cardPaymentInfo.last4,
      );
      return {
        inserted: false,
        receiptInserted: false,
        // Só é "vinculado" se de fato achamos o cartão. Sem cartão, o pagamento
        // sai do caixa (§10) mas NÃO quita fatura nenhuma — o commit avisa.
        cardPayment: false,
        unlinkedCardPayment: true,
        expenseId: e.id,
      };
    }

    const manualExpenseType = categoryOverride ? null : await this.merchantClassifier.manualExpenseType(tx.merchant, tenantId);
    const isPixPfWithoutRule =
      !categoryOverride &&
      !manualExpenseType &&
      MerchantClassifierService.isLikelyPixPessoaFisica(tx.merchant);
    const expenseType = categoryOverride ||
      manualExpenseType ||
      (isPixPfWithoutRule
        ? 'OUTROS'
        : fastClassify(tx.merchant) ||
          (PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS'));
    const titulo = tx.merchant.slice(0, 200);

    const expense = await client.expense.create({
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
        createdByUserId,
      },
    });

    // Perna de DÉBITO de movimentação interna (aplicação): NÃO gera CashFlowEntry.
    // ATENÇÃO (#574): isso é ASSIMÉTRICO em relação à perna de CRÉDITO (resgate,
    // ver isInternalMov acima) — aquela GERA CashFlowEntry RECEBIMENTO normalmente.
    // Resultado hoje: uma transferência interna simétrica (aplica R$X + resgata R$X,
    // líquido zero) aparece como +R$X de entrada real no saldo consolidado, em vez
    // de neutra. Correção pendente de decisão de produto — ver issue #574.
    if (expenseType === 'MOVIMENTACAO_INTERNA') {
      return { inserted: false, receiptInserted: false, cardPayment: false, unlinkedCardPayment: false, expenseId: expense.id };
    }

    await client.cashFlowEntry.create({
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

    return { inserted: true, receiptInserted: false, cardPayment: false, unlinkedCardPayment: false, expenseId: expense.id };
  }

  private async createCardPaymentExpense(
    client: SettlementClient,
    tenantId: string,
    projectId: string,
    account: { last4: string },
    transaction: NormalizedTx,
    importId: string,
    createdByUserId: string | null,
    matchedCard: MatchedSettlementCard | null,
    detectedLast4: string | null,
  ): Promise<{ id: string }> {
    return client.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        titulo: matchedCard
          ? `Pagamento fatura ${matchedCard.nickname}`
          : transaction.merchant.slice(0, 200),
        fornecedor: transaction.merchant.slice(0, 200),
        valor: transaction.amountCents,
        quantidade: 1,
        valorTotal: transaction.amountCents,
        formaPagamento: 'A_VISTA',
        dataPagamento: transaction.date,
        status: 'PAGO',
        importId,
        externalId: transaction.externalId,
        bankLast4: account.last4,
        cardLast4: matchedCard?.last4 ?? detectedLast4,
        createdByUserId,
      },
      select: { id: true },
    });
  }

  /**
   * Carrega, para cada cartão do tenant, os lançamentos de caixa das COMPRAS
   * (não-neutras) numa janela de datas — insumo puro de `rankCardCandidates`.
   *
   * ponytail: uma query por import (não por transação). Se um dia o tenant tiver
   * dezenas de milhares de lançamentos, restringir a janela ou agregar em SQL.
   */
  /** Cartões do tenant com suas compras no período — base do ranking de faturas candidatas. */
  async loadCardsWithEntries(
    tenantId: string,
    from: Date,
    to: Date,
    requester: RateioRequester,
    client: SettlementClient = this.prisma,
    scopedCards?: Array<Omit<CardWithEntries, 'entries'>>,
  ): Promise<CardWithEntries[]> {
    assertRateioRequester(requester);
    const scope = scopedCards
      ? null
      : // O recurso carregado é o CARTÃO: exige `creditCards` no projeto dono
        // dele. Vale para todo consumidor do loader — inclusive o candidato
        // aninhado da fila de pendências (#480 SEC-1).
        await resolveAccessibleProjectScope(
          client,
          tenantId,
          requester.role,
          requester.allowedProjects,
          requester.allowedProjectTypes,
          requester.allowedModules ?? [],
          CREDIT_CARD_MODULE,
        );
    const candidateCards = scopedCards ?? (await client.creditCard.findMany({
      where: {
        tenantId,
        deletedAt: null,
        project: { deletedAt: null },
        ...(scope !== null ? { projectId: { in: scope } } : {}),
      },
      select: {
        id: true,
        projectId: true,
        last4: true,
        nickname: true,
        brand: true,
        closingDay: true,
        dueDay: true,
      },
    })).map((card) => ({
      id: card.id,
      projectId: card.projectId,
      last4: card.last4,
      nickname: card.nickname?.trim() || `${card.brand} ••${card.last4}`,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
    }));
    const byLast4 = new Map<string, Array<Omit<CardWithEntries, 'entries'>>>();
    for (const card of candidateCards) {
      const group = byLast4.get(card.last4) ?? [];
      group.push(card);
      byLast4.set(card.last4, group);
    }
    // A API legada identifica cartão por last4. Enquanto não houver cardId no
    // contrato público, um grupo duplicado é intrinsecamente ambíguo.
    const cards = [...byLast4.values()]
      .filter((group) => group.length === 1)
      .map(([card]) => card);
    if (cards.length === 0) return [];
    const cardScopes = cards.filter(
      (card): card is Omit<CardWithEntries, 'entries'> & { projectId: string } =>
        Boolean(card.projectId),
    );
    if (cardScopes.length !== cards.length) return [];

    const entries = await client.cashFlowEntry.findMany({
      where: {
        tenantId,
        tipo: 'DESPESA',
        deletedAt: null,
        data: { gte: from, lte: to },
        OR: cardScopes.map((card) => ({
          projectId: card.projectId,
          expense: {
            projectId: card.projectId,
            cardLast4: card.last4,
            deletedAt: null,
            tipoDespesa: { notIn: Array.from(NEUTRAL_EXPENSE_TYPES) },
          },
        })),
      },
      select: {
        projectId: true,
        valor: true,
        data: true,
        expense: { select: { cardLast4: true } },
      },
    });

    const entriesByCard = new Map<string, Array<{ data: Date; valor: number }>>();
    for (const entry of entries) {
      const last4 = entry.expense?.cardLast4;
      if (!last4) continue;
      const key = `${entry.projectId}:${last4}`;
      const list = entriesByCard.get(key) ?? [];
      list.push({ data: entry.data, valor: entry.valor });
      entriesByCard.set(key, list);
    }

    return cards.map((card) => ({
      id: card.id,
      projectId: card.projectId,
      last4: card.last4,
      nickname: card.nickname,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      entries: entriesByCard.get(`${card.projectId}:${card.last4}`) ?? [],
    }));
  }

  /** Janela de datas que cobre as faturas relacionadas às transações do arquivo. */
  private cardEntryWindow(transactions: Array<{ date: Date }>): { from: Date; to: Date } {
    const times = transactions.map((t) => t.date.getTime());
    const min = times.length > 0 ? Math.min(...times) : Date.now();
    const max = times.length > 0 ? Math.max(...times) : Date.now();
    const from = new Date(min);
    from.setUTCDate(from.getUTCDate() - 120);
    const to = new Date(max);
    to.setUTCDate(to.getUTCDate() + 120);
    return { from, to };
  }

  private async findCardByLast4(
    tenantId: string,
    last4: string,
    client: SettlementClient = this.prisma,
    authorizedCardIds?: string[],
  ): Promise<MatchedSettlementCard | null> {
    const cards = await client.creditCard.findMany({
      where: {
        tenantId,
        last4,
        deletedAt: null,
        ...(authorizedCardIds ? { id: { in: authorizedCardIds } } : {}),
      },
      select: {
        id: true,
        last4: true,
        nickname: true,
        closingDay: true,
        dueDay: true,
      },
      take: 2,
    });
    return cards.length === 1 ? cards[0] : null;
  }

  /**
   * Tenta achar um CreditCard do tenant para associar a um pagamento de fatura.
   * Estratégia:
   *   1. Se hint de last4 detectado na descrição: match exato.
   *   2. Senão: procurar CreditCardStatementImport com totalAmountCents ≈ amountCents
   *      (±R$ 1) e cuja fatura está num período compatível (até 60 dias antes do pagamento).
   *   3. Senão: casar contra o total da fatura EM ABERTO (derivado das compras do
   *      cartão por mês de vencimento) — não exige que a fatura tenha sido
   *      importada. Só aceita match sem ambiguidade.
   *   4. Senão: qualquer cartão único do tenant (fallback se houver 1 só).
   */
  private async findMatchingCreditCard(
    tenantId: string,
    amountCents: number,
    paymentDate: Date,
    hintLast4: string | null,
    cardCandidates: CardInvoiceCandidate[] = [],
    client: SettlementClient = this.prisma,
    authorizedCardIds?: string[],
  ): Promise<MatchedSettlementCard | null> {
    if (hintLast4) {
      const byHint = await client.creditCard.findFirst({
        where: {
          tenantId,
          last4: hintLast4,
          deletedAt: null,
          ...(authorizedCardIds ? { id: { in: authorizedCardIds } } : {}),
        },
        select: {
          id: true,
          last4: true,
          nickname: true,
          closingDay: true,
          dueDay: true,
        },
      });
      if (byHint) return byHint;
    }

    const sixtyDaysBefore = new Date(paymentDate);
    sixtyDaysBefore.setDate(sixtyDaysBefore.getDate() - 60);
    const tolerance = 200; // R$ 2 de tolerância (encargos podem variar)
    const matchedImport = await client.creditCardStatementImport.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        createdAt: { gte: sixtyDaysBefore },
        totalAmountCents: { gte: amountCents - tolerance, lte: amountCents + tolerance },
        ...(authorizedCardIds ? { cardId: { in: authorizedCardIds } } : {}),
        card: { deletedAt: null },
      },
      include: {
        card: {
          select: {
            id: true,
            last4: true,
            nickname: true,
            closingDay: true,
            dueDay: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (matchedImport?.card) return matchedImport.card;

    // Fatura em aberto com o mesmo total — funciona mesmo sem a fatura importada.
    const byInvoiceTotal = pickUniqueCardMatch(cardCandidates);
    if (byInvoiceTotal) {
      const card = await this.findCardByLast4(
        tenantId,
        byInvoiceTotal.cardLast4,
        client,
        authorizedCardIds,
      );
      if (card && (!authorizedCardIds || authorizedCardIds.includes(card.id))) {
        return card;
      }
    }

    const cards = await client.creditCard.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(authorizedCardIds ? { id: { in: authorizedCardIds } } : {}),
      },
      select: {
        id: true,
        last4: true,
        nickname: true,
        closingDay: true,
        dueDay: true,
      },
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
    client: SettlementClient = this.prisma,
    authorizedCardIds?: string[],
  ): Promise<MatchedSettlementCard | null> {
    const tenDaysBefore = new Date(paymentDate);
    tenDaysBefore.setDate(tenDaysBefore.getDate() - 10);
    const tenDaysAfter = new Date(paymentDate);
    tenDaysAfter.setDate(tenDaysAfter.getDate() + 10);
    const tolerance = 50; // R$ 0,50
    const matches = await client.creditCardStatementImport.findMany({
      where: {
        tenantId,
        deletedAt: null,
        createdAt: { gte: tenDaysBefore, lte: tenDaysAfter },
        totalAmountCents: { gte: amountCents - tolerance, lte: amountCents + tolerance },
        ...(authorizedCardIds ? { cardId: { in: authorizedCardIds } } : {}),
        card: { deletedAt: null },
      },
      include: {
        card: {
          select: {
            id: true,
            last4: true,
            nickname: true,
            closingDay: true,
            dueDay: true,
          },
        },
      },
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
  if (/^PIX\s+TRANSF|^TED|^DOC|TRANSFER[EÊ]NCIA|CREDITO\s+LIBERAD/.test(m)) return 'TRANSFERENCIA_PROPRIA';
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
    valorTotal: e.valorTotal,
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
