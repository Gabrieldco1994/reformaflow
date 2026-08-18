import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseService } from '../expense/expense.service';
import { MerchantClassifierService } from '../merchant-classifier/merchant-classifier.service';
import {
  detectRecurringSeries,
  type RecurrenceDetectorRow,
  ExpenseTypeLabels,
} from '@reformaflow/domain';
import {
  assertRateioRequester,
  RateioRequester,
} from '../expense/rateio.types';

/**
 * Séries de despesa recorrente do PESSOAL.
 *
 * Não há tabela de série: a recorrência é DERIVADA das despesas existentes a
 * cada leitura (o app materializa recorrência como N despesas independentes, e
 * a flag `Expense.recorrente` nunca foi usada — 0 linhas em produção). A
 * identidade da série é o merchant normalizado, que é determinístico.
 *
 * ponytail: sem tabela `RecurrenceSeries` — nada aqui precisa de estado que as
 * próprias despesas não carreguem. Criar a tabela quando surgir estado que só
 * ela comporta (pausar uma série sem nenhuma ocorrência futura, ou dispensar
 * uma detecção).
 */
/** Sem corte de cadência: o que entra no detector já é recorrência confirmada. */
const ALL = { minMeses: 1, maxPorMes: Number.POSITIVE_INFINITY };

@Injectable()
export class RecurrenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expenses: ExpenseService,
  ) {}

/**
 * Chave da série a partir do título.
 *
 * `normalizeKey` só remove data com fronteira de palavra, então "LUCIANA13/03"
 * vira "luciana13 03" e cada mês produz uma chave diferente — a série some.
 * Limpo a data ANTES (inclusive colada no nome) em vez de mexer no
 * `normalizeKey`, que é compartilhado e tem regras de merchant já persistidas
 * no banco com as chaves atuais.
 */
/**
 * Título de parcelamento ("Reisman - Parcela 7/10", "Sodimac (3/3)").
 * Parcela repete todo mês como recorrência, mas tem fim e não é assinatura —
 * entraria na tela como falso positivo. `seriesKey` (parcelamento vindo da
 * fatura) só cobre parte; o digitado à mão não tem carimbo nenhum.
 */
static isParcela(titulo: string): boolean {
  return /\b(parcela|parc\.?)\b|\(\s*\d{1,2}\s*\/\s*\d{1,2}\s*\)/i.test(titulo ?? '');
}

static seriesKey(titulo: string): string {
  const semData = (titulo ?? '')
    .replace(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g, ' ')
    .replace(/\d+\s*$/, ' ');
  return MerchantClassifierService.normalizeKey(semData);
}

/** Início do dia de hoje em UTC — fronteira entre passado imutável e futuro editável. */
  private static cutoff(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  static encodeKey(key: string): string {
    return Buffer.from(key, 'utf8').toString('base64url');
  }

  static decodeKey(encoded: string): string {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  }

  private async loadRows(tenantId: string, projectId: string) {
    return this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId,
        deletedAt: null,
        // Parcelamento (6/10, 16/21) já tem sua própria identidade de série e
        // cairia aqui como falso positivo mensal.
        seriesKey: null,
      },
      select: {
        id: true,
        titulo: true,
        tipoDespesa: true,
        valorTotal: true,
        dataPagamento: true,
        dataCompra: true,
        status: true,
        createdAt: true,
        linkedExpenseId: true,
        recurrenceKey: true,
        importId: true,
      },
    });
  }

  /**
   * Ids das despesas que nasceram de UMA criação de recorrência antes do
   * carimbo `recurrenceKey` existir.
   *
   * Materializar uma recorrência grava N despesas de mesmo título e valor no
   * mesmo instante — assinatura que nenhuma linha de extrato produz. Restrinjo
   * a `importId: null` porque uma importação também grava em lote.
   *
   * ponytail: sem heurística de extrato aqui. Detectar assinatura no extrato
   * trazia 64 séries, quase tudo ruído de título truncado pelo banco; o usuário
   * quer ver só o que ELE criou. Se um dia quiser "achei estas assinaturas no
   * seu extrato", isso é uma aba separada, não o conteúdo desta.
   */
  private static manualBatchIds(
    rows: Awaited<ReturnType<RecurrenceService['loadRows']>>,
  ): Set<string> {
    const BATCH_WINDOW_MS = 120_000;
    const groups = new Map<string, { id: string; at: number }[]>();
    for (const r of rows) {
      if (r.recurrenceKey || r.importId) continue;
      if (RecurrenceService.isParcela(r.titulo ?? '')) continue;
      const g = `${(r.titulo ?? '').trim().toLowerCase()}|${r.valorTotal}`;
      (groups.get(g) ?? groups.set(g, []).get(g)!).push({
        id: r.id,
        at: r.createdAt.getTime(),
      });
    }
    const ids = new Set<string>();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const at = g.map((x) => x.at);
      if (Math.max(...at) - Math.min(...at) > BATCH_WINDOW_MS) continue;
      for (const x of g) ids.add(x.id);
    }
    return ids;
  }

  private static toDetectorRows(
    rows: Awaited<ReturnType<RecurrenceService['loadRows']>>,
  ): { detector: RecurrenceDetectorRow[]; byId: Map<string, (typeof rows)[number]> } {
    const byId = new Map<string, (typeof rows)[number]>();
    const detector: RecurrenceDetectorRow[] = [];
    const manual = RecurrenceService.manualBatchIds(rows);
    for (const r of rows) {
      // Cadência independe de pagamento: as séries que o usuário criou pelo
      // toggle estão como PLANEJADO e precisam ser detectadas do mesmo jeito.
      const data = r.dataPagamento ?? r.dataCompra ?? r.createdAt;
      if (!data) continue;
      // Carimbo explícito vence a heurística: quem nasceu do fluxo de
      // recorrência é série por FATO, não por parecer uma.
      if (!r.recurrenceKey && !manual.has(r.id)) continue;
      const key = r.recurrenceKey ?? RecurrenceService.seriesKey(r.titulo ?? '');
      if (!key) continue;
      byId.set(r.id, r);
      detector.push({
        id: r.id,
        key,
        tipoDespesa: r.tipoDespesa,
        valorTotal: r.valorTotal,
        data,
      });
    }
    return { detector, byId };
  }

  async list(tenantId: string, projectId: string) {
    const rows = await this.loadRows(tenantId, projectId);
    const { detector, byId } = RecurrenceService.toDetectorRows(rows);
    // Toda linha que chega aqui já é recorrência por FATO (carimbo ou lote de
    // criação); o detector só agrupa e calcula frequência, não decide.
    const series = detectRecurringSeries(detector, ALL);
    const cutoff = RecurrenceService.cutoff();

    return series.map((s) => {
      const occurrences = s.expenseIds
        .map((id) => byId.get(id))
        .filter((e): e is NonNullable<typeof e> => !!e);

      const futuras = occurrences.filter((e) => RecurrenceService.isFuture(e, cutoff));
      const proxima = futuras
        .map((e) => e.dataPagamento ?? e.dataCompra)
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime())[0];

      const titulo = occurrences[occurrences.length - 1]?.titulo ?? s.nome;

      return {
        key: RecurrenceService.encodeKey(s.key),
        nome: titulo,
        tipoDespesa: s.tipoDespesa,
        tipoDespesaLabel:
          ExpenseTypeLabels[s.tipoDespesa as keyof typeof ExpenseTypeLabels] ?? s.tipoDespesa,
        frequencia: s.frequencia,
        diaVencimento: s.diaVencimento,
        valorCents: s.valorCentsAtual,
        ocorrencias: s.ocorrencias,
        ocorrenciasPagas: occurrences.filter((e) => e.status === 'PAGO').length,
        ocorrenciasFuturas: futuras.length,
        primeiraData: s.primeiraData.toISOString(),
        ultimaData: s.ultimaData.toISOString(),
        proximaData: proxima ? proxima.toISOString() : null,
        temEspelho: occurrences.some((e) => !!e.linkedExpenseId),
      };
    });
  }

  private static isFuture(
    e: { status: string; dataPagamento: Date | null; dataCompra: Date | null },
    cutoff: Date,
  ): boolean {
    if (e.status === 'PAGO') return false;
    const d = e.dataPagamento ?? e.dataCompra;
    return !!d && d.getTime() >= cutoff.getTime();
  }

  /** Ocorrências futuras da série — o único conjunto que edição/exclusão pode tocar. */
  private async futureOccurrences(tenantId: string, projectId: string, key: string) {
    const rows = await this.loadRows(tenantId, projectId);
    const { detector, byId } = RecurrenceService.toDetectorRows(rows);
    const serie = detectRecurringSeries(detector, ALL).find((s) => s.key === key);
    if (!serie) throw new NotFoundException('Recorrência não encontrada');

    const cutoff = RecurrenceService.cutoff();
    return serie.expenseIds
      .map((id) => byId.get(id))
      .filter((e): e is NonNullable<typeof e> => !!e && RecurrenceService.isFuture(e, cutoff));
  }

  /**
   * Edita a série: aplica `valor`/`tipoDespesa` apenas às ocorrências FUTURAS.
   * O histórico pago nunca é reescrito — o extrato é fato consumado e alterá-lo
   * falsearia o caixa.
   *
   * Reusa `ExpenseService.update` por ocorrência para herdar a regeneração de
   * cashflow e a propagação do espelho cross-project; reimplementar isso aqui
   * dessincronizaria o espelho.
   */
  async update(
    tenantId: string,
    projectId: string,
    encodedKey: string,
    dto: { valor?: number; tipoDespesa?: string },
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const key = RecurrenceService.decodeKey(encodedKey);
    const futuras = await this.futureOccurrences(tenantId, projectId, key);

    for (const occ of futuras) {
      await this.expenses.update(tenantId, projectId, occ.id, {
        ...(dto.valor !== undefined ? { valor: dto.valor } : {}),
        ...(dto.tipoDespesa !== undefined ? { tipoDespesa: dto.tipoDespesa } : {}),
      } as never, requester);
    }

    return { atualizadas: futuras.length, preservadasPagas: true };
  }

  /** Exclui a série: apaga só as ocorrências futuras. As pagas permanecem. */
  async remove(
    tenantId: string,
    projectId: string,
    encodedKey: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const key = RecurrenceService.decodeKey(encodedKey);
    const futuras = await this.futureOccurrences(tenantId, projectId, key);

    for (const occ of futuras) {
      await this.expenses.remove(tenantId, projectId, occ.id, requester);
    }

    return { excluidas: futuras.length, preservadasPagas: true };
  }
}
