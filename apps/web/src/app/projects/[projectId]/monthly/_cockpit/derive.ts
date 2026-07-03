import type { MonthlyOverviewResponse, MonthlyOverviewRow, MonthlyEntry } from '../_types';
import {
  caixaDateForCardPurchase,
  buildMonthlyOverview,
  type MonthlyOverviewEntry,
} from '@reformaflow/domain';
import { entryIsNeutral, isNeutralAccountSettlement } from './neutral';

/** Categorias com cor fixa (significado consistente em todo o cockpit). */
export const CAT_COLORS: Record<string, string> = {
  Moradia: '#0A6CF0',
  Alimentação: '#1E924A',
  Transporte: '#B5803A',
  Lazer: '#7A3FC2',
  Saúde: '#D92D20',
  Receita: '#1E924A',
};
const CAT_PALETTE = ['#0A6CF0', '#1E924A', '#B5803A', '#7A3FC2', '#D92D20', '#1E7BFF', '#C2691E', '#0F766E'];

export function colorForCategoria(cat: string, index: number): string {
  return CAT_COLORS[cat] ?? CAT_PALETTE[index % CAT_PALETTE.length]!;
}

function isRealized(status: string): boolean {
  return status === 'PAGO' || status === 'EM_CAIXA';
}

function dayOfMonth(data: string): number {
  // data é ISO ("2026-06-05T00:00:00.000Z"); pega o dia em UTC sem deslocar timezone.
  const d = data.slice(8, 10);
  const n = parseInt(d, 10);
  return Number.isFinite(n) ? n : 1;
}

function parseMesKey(mes: string): { year: number; month0: number } {
  const [y, m] = mes.split('-');
  return { year: parseInt(y ?? '0', 10), month0: parseInt(m ?? '1', 10) - 1 };
}

/** Chave YYYY-MM do mês anterior a `mes`. */
function prevMonthKey(mes: string): string {
  const { year, month0 } = parseMesKey(mes);
  const d = new Date(Date.UTC(year, month0 - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Caixa real (§10) acumulado ao FIM de `mesKey`: último ponto de `porMes` com mês ≤ mesKey,
 * senão o saldo inicial (opening). `porMes` só tem meses com movimento de conta, então o
 * saldo "carrega" do último mês com lançamento.
 */
function caixaRealAoFimDoMes(
  caixa: NonNullable<MonthlyOverviewResponse['caixa']>,
  mesKey: string,
): number {
  let val = caixa.saldoInicial;
  for (const p of [...caixa.porMes].sort((a, b) => a.mes.localeCompare(b.mes))) {
    if (p.mes <= mesKey) val = p.caixa;
    else break;
  }
  return val;
}

// ───────────────────────── Visão do mês ─────────────────────────

export interface DiaSaldo {
  dia: number;
  realizado: number | null;
  projetado: number | null;
}

export interface ContaFutura {
  dia: number;
  nome: string;
  valor: number; // centavos, positivo = despesa a pagar
  categoria: string;
}

export interface CategoriaBarra {
  categoria: string;
  valor: number; // centavos
  cor: string;
  pct: number; // 0..1 sobre o maior
}

export interface MonthDerived {
  mesAtualKey: string;
  year: number;
  month0: number;
  hoje: number;
  diasNoMes: number;
  diasRestantes: number;

  saldoInicial: number;
  saldoAtual: number;
  /** true = saldoInicial/saldoAtual são o caixa real (§10) reconciliado; false = fluxo/projeção. */
  caixaReal: boolean;
  gasteiRealizado: number;
  gasteiPlanejado: number;
  entrouRealizado: number;
  entrouPrevisto: number;

  /** Ritmo diário de gasto variável calculado dos dados (centavos/dia). */
  ritmoDiario: number;
  /** Entradas/saídas conhecidas ainda não realizadas, por dia (>= hoje+1). */
  agendadosPorDia: Map<number, number>; // centavos com sinal
  contasFuturas: ContaFutura[];

  categorias: CategoriaBarra[];
  maiorGastoVariavel: CategoriaBarra | null;

  reservaMeses: number;
  reservaMeta: number;
  despesaMensalMedia: number;
}

const FORMA_FIXA = new Set(['PARCELADO', 'QUINZENAL']);

export function deriveMonth(
  data: MonthlyOverviewResponse,
  monthKey: string = data.mesAtual,
  entriesArg?: MonthlyEntry[],
): MonthDerived {
  const { mesAtualKey, year, month0 } = (() => {
    const p = parseMesKey(monthKey);
    return { mesAtualKey: monthKey, ...p };
  })();

  const diasNoMes = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

  // Entries do mês selecionado: usa o argumento, senão filtra da lista completa,
  // senão cai no mês corrente (compatibilidade).
  const entries =
    entriesArg ??
    (data.entries
      ? data.entries.filter((e) => (e.data ?? '').slice(0, 7) === mesAtualKey)
      : data.mesAtualEntries);

  // "Hoje": mês passado = totalmente realizado; mês corrente = dia real;
  // mês futuro = nada realizado ainda (tudo projeção).
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let hoje: number;
  if (mesAtualKey < nowKey) hoje = diasNoMes;
  else if (mesAtualKey === nowKey) hoje = Math.min(now.getDate(), diasNoMes);
  else hoje = 0;
  const diasRestantes = Math.max(0, diasNoMes - hoje);

  // Saldo inicial = posição estimada de caixa no 1º dia do mês selecionado.
  // - Meses puramente passados (< hoje): usa o REALIZADO (o que de fato aconteceu).
  // - Meses entre "hoje" e o mês selecionado: usa o TOTAL (assume que o planejado vai
  //   sair) para projetar o saldo de entrada nos meses futuros.
  let saldoInicialFluxo = 0;
  for (const r of data.meses) {
    if (r.mes >= mesAtualKey) continue;
    if (r.mes < nowKey) saldoInicialFluxo += r.saldoMesRealizado;
    else saldoInicialFluxo += r.saldoMes;
  }

  let gasteiRealizado = 0;
  let gasteiPlanejado = 0;
  let entrouRealizado = 0;
  let entrouPrevisto = 0;
  let variavelRealizadoAteHoje = 0;

  const agendadosPorDia = new Map<number, number>();
  const contasFuturas: ContaFutura[] = [];

  for (const e of entries) {
    // Consolidado (deriveMonth não filtra projeto): espelho deduplicado — o registro
    // do projeto-alvo é o canônico, coerente com data.meses (linhas espelho-free).
    if (e.isEspelho) continue;
    const realized = isRealized(e.status);
    const dia = dayOfMonth(e.data);
    if (e.tipo === 'DESPESA') {
      if (realized) {
        gasteiRealizado += e.valor;
        if (!FORMA_FIXA.has(e.formaPagamento ?? '') && dia <= hoje) {
          variavelRealizadoAteHoje += e.valor;
        }
      } else {
        gasteiPlanejado += e.valor;
        const diaAlvo = dia > hoje ? dia : Math.min(hoje + 1, diasNoMes);
        agendadosPorDia.set(diaAlvo, (agendadosPorDia.get(diaAlvo) ?? 0) - e.valor);
        contasFuturas.push({
          dia: diaAlvo,
          nome: e.categoria ?? 'Despesa',
          valor: e.valor,
          categoria: e.categoria ?? 'Outros',
        });
      }
    } else {
      if (realized) {
        entrouRealizado += e.valor;
      } else {
        entrouPrevisto += e.valor;
        const diaAlvo = dia > hoje ? dia : Math.min(hoje + 1, diasNoMes);
        agendadosPorDia.set(diaAlvo, (agendadosPorDia.get(diaAlvo) ?? 0) + e.valor);
      }
    }
  }

  // Saldo (caixa): por padrão usa o FLUXO (conta+cartão); quando há saldo inicial real
  // cadastrado (§10), rebaseia no CAIXA REAL reconciliado com o banco, alinhando este
  // número com o card "Caixa" do topo do cockpit. Meses futuros = projeção a partir do
  // caixa real de hoje + fluxo projetado (caixaReal=false → rótulo de projeção).
  let saldoInicial = saldoInicialFluxo;
  let saldoAtual = saldoInicial + entrouRealizado - gasteiRealizado;
  let caixaReal = false;
  if (data.caixa?.temSaldoInicial) {
    const c = data.caixa;
    if (mesAtualKey <= nowKey) {
      saldoInicial = caixaRealAoFimDoMes(c, prevMonthKey(mesAtualKey));
      saldoAtual = mesAtualKey === nowKey ? c.hoje : caixaRealAoFimDoMes(c, mesAtualKey);
      caixaReal = true;
    } else {
      // Futuro: parte do caixa real de hoje + o que ainda falta acontecer no mês corrente
      // + o líquido projetado dos meses intermediários.
      const rowNow = data.meses.find((r) => r.mes === nowKey);
      let base = c.hoje + (rowNow ? rowNow.saldoMes - rowNow.saldoMesRealizado : 0);
      for (const r of data.meses) {
        if (r.mes > nowKey && r.mes < mesAtualKey) base += r.saldoMes;
      }
      const rowM = data.meses.find((r) => r.mes === mesAtualKey);
      saldoInicial = base;
      saldoAtual = base + (rowM?.saldoMes ?? 0);
    }
  }
  const ritmoDiario = hoje > 0 ? Math.round(variavelRealizadoAteHoje / hoje) : 0;

  // Categorias de despesa do mês corrente (todas, realizado + planejado).
  const row = data.meses.find((r) => r.mes === mesAtualKey);
  const cats = (row?.porCategoria ?? []).filter((c) => c.valor > 0);
  const maxCat = cats.reduce((mx, c) => Math.max(mx, c.valor), 0);
  const categorias: CategoriaBarra[] = cats.map((c, i) => ({
    categoria: c.categoria,
    valor: c.valor,
    cor: colorForCategoria(c.categoria, i),
    pct: maxCat > 0 ? c.valor / maxCat : 0,
  }));

  // Maior gasto "variável": maior categoria que não seja tipicamente fixa (Moradia/Mão de Obra).
  const FIXAS = new Set(['Moradia', 'Mão de Obra', 'Aluguel']);
  const maiorGastoVariavel = categorias.find((c) => !FIXAS.has(c.categoria)) ?? categorias[0] ?? null;

  // Reserva de emergência = saldo atual / despesa mensal média (meses com despesa realizada).
  const mesesComDespesa = data.meses.filter((r) => r.despesasRealizadas > 0);
  const despesaMensalMedia = mesesComDespesa.length > 0
    ? Math.round(mesesComDespesa.reduce((s, r) => s + r.despesasRealizadas, 0) / mesesComDespesa.length)
    : 0;
  const reservaMeses = despesaMensalMedia > 0 ? saldoAtual / despesaMensalMedia : 0;

  return {
    mesAtualKey, year, month0, hoje, diasNoMes, diasRestantes,
    saldoInicial, saldoAtual, caixaReal, gasteiRealizado, gasteiPlanejado, entrouRealizado, entrouPrevisto,
    ritmoDiario, agendadosPorDia, contasFuturas,
    categorias, maiorGastoVariavel,
    reservaMeses, reservaMeta: 6, despesaMensalMedia,
  };
}

/** Série de saldo dia-a-dia. Recalcula projeção com o ritmo informado (slider). */
export function buildSaldoSeries(m: MonthDerived, entries: MonthlyEntry[], ritmoDiario: number): DiaSaldo[] {
  // Realizado acumulado por dia (1..hoje).
  const realizadoPorDia = new Map<number, number>();
  for (const e of entries) {
    // Mesmo filtro do deriveMonth: espelho cross-project é deduplicado (não dobra).
    if (e.isEspelho) continue;
    if (!isRealized(e.status)) continue;
    const dia = dayOfMonth(e.data);
    const sign = e.tipo === 'RECEBIMENTO' ? e.valor : -e.valor;
    realizadoPorDia.set(dia, (realizadoPorDia.get(dia) ?? 0) + sign);
  }

  const serie: DiaSaldo[] = [];
  let running = m.saldoInicial;
  for (let dia = 1; dia <= m.hoje; dia++) {
    running += realizadoPorDia.get(dia) ?? 0;
    serie.push({ dia, realizado: running, projetado: dia === m.hoje ? running : null });
  }

  // Projeção de hoje+1 até fim do mês.
  let proj = m.hoje > 0 ? running : m.saldoInicial;
  if (m.hoje === 0) {
    // Mês ainda não começou para "hoje": ancora ponto inicial.
    serie.push({ dia: 0, realizado: m.saldoInicial, projetado: m.saldoInicial });
  }
  for (let dia = m.hoje + 1; dia <= m.diasNoMes; dia++) {
    proj -= ritmoDiario;
    proj += m.agendadosPorDia.get(dia) ?? 0;
    serie.push({ dia, realizado: null, projetado: proj });
  }
  return serie;
}

/** Saldo projetado no último dia, dado um ritmo diário. */
export function saldoProjetado(m: MonthDerived, ritmoDiario: number): number {
  let proj = m.saldoAtual;
  for (let dia = m.hoje + 1; dia <= m.diasNoMes; dia++) {
    proj -= ritmoDiario;
    proj += m.agendadosPorDia.get(dia) ?? 0;
  }
  return proj;
}

// ───────────────────────── Visão do ano ─────────────────────────

export interface MesAno {
  mesIndex0: number;
  label: string;
  rec: number;
  desp: number;
  sobra: number;
  real: boolean;
  patrimonio: number; // acumulado ao fim do mês
}

export interface YearDerived {
  year: number;
  meses: MesAno[];
  receitaAno: number;
  despesaAno: number;
  resultadoAno: number;
  taxaPoupanca: number; // %
  metaPoupanca: number; // %
  patrimonioInicioAno: number;
  patrimonioFimAno: number;
  crescimentoPatrimonioPct: number | null;
  melhorMes: MesAno | null;
  piorMes: MesAno | null;
  sobraMedia: number;
}

const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export function deriveYear(data: MonthlyOverviewResponse, year: number): YearDerived {
  const byKey = new Map<string, MonthlyOverviewRow>();
  for (const r of data.meses) byKey.set(r.mes, r);

  const patrimonioInicioAno = data.meses
    .filter((r) => r.mes < `${year}-01`)
    .reduce((s, r) => s + r.saldoMesRealizado, 0);

  const meses: MesAno[] = [];
  let patrimonio = patrimonioInicioAno;
  let receitaAno = 0;
  let despesaAno = 0;
  for (let i = 0; i < 12; i++) {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const r = byKey.get(key);
    const rec = r?.totalRecebimentos ?? 0;
    const desp = r?.totalDespesas ?? 0;
    const sobra = rec - desp;
    patrimonio += sobra;
    receitaAno += rec;
    despesaAno += desp;
    meses.push({
      mesIndex0: i,
      label: MESES_CURTO[i]!,
      rec,
      desp,
      sobra,
      real: key < data.mesAtual,
      patrimonio,
    });
  }

  const resultadoAno = receitaAno - despesaAno;
  const taxaPoupanca = receitaAno > 0 ? (resultadoAno / receitaAno) * 100 : 0;

  const mesesComMovimento = meses.filter((m) => m.rec !== 0 || m.desp !== 0);
  const melhorMes = mesesComMovimento.reduce<MesAno | null>((best, m) => (!best || m.sobra > best.sobra ? m : best), null);
  const piorMes = mesesComMovimento.reduce<MesAno | null>((worst, m) => (!worst || m.sobra < worst.sobra ? m : worst), null);
  const sobraMedia = mesesComMovimento.length > 0
    ? Math.round(mesesComMovimento.reduce((s, m) => s + m.sobra, 0) / mesesComMovimento.length)
    : 0;

  const patrimonioFimAno = patrimonio;
  const crescimentoPatrimonioPct = patrimonioInicioAno !== 0
    ? ((patrimonioFimAno - patrimonioInicioAno) / Math.abs(patrimonioInicioAno)) * 100
    : null;

  return {
    year, meses, receitaAno, despesaAno, resultadoAno, taxaPoupanca, metaPoupanca: 30,
    patrimonioInicioAno, patrimonioFimAno, crescimentoPatrimonioPct,
    melhorMes, piorMes, sobraMedia,
  };
}

/** Anos disponíveis nos dados (para navegação futura). */
export function anosDisponiveis(data: MonthlyOverviewResponse): number[] {
  const set = new Set<number>();
  for (const r of data.meses) set.add(parseMesKey(r.mes).year);
  return Array.from(set).sort();
}

// ───────────── Totais globais: caixa atual e saldo projetado ─────────────

export interface TotalsDerived {
  /** Realizado acumulado (entradas EM_CAIXA − saídas PAGO). */
  caixaAgora: number;
  /** Caixa atual + futuro conhecido (a receber − a pagar). */
  saldoProjetado: number;
  entradasRealizadas: number;
  saidasRealizadas: number;
  entradasPrevistas: number;
  saidasPlanejadas: number;
}

/**
 * Totais do "agora" e projetado. Por padrão considera só o projeto PESSOAL
 * (espelha o consolidado financeiro do extrato+faturas); passe onlyPessoal=false
 * para incluir os demais projetos.
 */
export function deriveTotals(
  data: MonthlyOverviewResponse,
  onlyPessoal = true,
): TotalsDerived {
  let er = 0, sr = 0, ep = 0, sp = 0;
  for (const e of data.entries ?? []) {
    if (onlyPessoal && e.projectType !== 'PESSOAL') continue;
    // Consolidado: o espelho (despesa PESSOAL vinculada) é deduplicado — o registro do
    // projeto-alvo é o canônico. No PESSOAL-only o espelho CONTA (a grana saiu da conta
    // pessoal; o alvo do outro projeto é filtrado pelo projectType acima).
    if (!onlyPessoal && e.isEspelho) continue;
    const realizado = e.status === 'PAGO' || e.status === 'EM_CAIXA';
    if (e.tipo === 'RECEBIMENTO') {
      if (realizado) er += e.valor; else ep += e.valor;
    } else {
      if (realizado) sr += e.valor; else sp += e.valor;
    }
  }
  const caixaAgora = er - sr;
  return {
    caixaAgora,
    saldoProjetado: caixaAgora + (ep - sp),
    entradasRealizadas: er,
    saidasRealizadas: sr,
    entradasPrevistas: ep,
    saidasPlanejadas: sp,
  };
}

// ───────────── Topo do cockpit: Caixa · Resultado · Projeção ─────────────

export interface CockpitTopDerived {
  /** Caixa base (centavos): real §10 se houver saldo inicial, senão fluxo realizado. */
  caixaValor: number;
  /** true = reconciliado com o banco (§10); false = só fluxo realizado (sem saldo inicial). */
  caixaReal: boolean;
  /** Variação do caixa no último mês com movimento (centavos). */
  caixaDelta: number;
  /** Série de saldo (centavos) para o sparkline. */
  caixaSpark: number[];

  /** Resultado realizado do mês corrente: entrou − gastou (centavos). */
  resultadoMes: number;
  resultadoEntrou: number;
  resultadoGastou: number;
  /** Variação % do resultado vs. mês anterior (null se não dá pra comparar). */
  resultadoDeltaPct: number | null;

  /** Projeção do fim do mês corrente: caixa + a receber − a pagar (centavos). */
  projecaoMes: number;
  aReceberMes: number;
  aPagarMes: number;

  mesAtualKey: string;
  /** Fração do mês já decorrida (0..1). */
  pctMesDecorrido: number;
}

export function deriveCockpitTop(data: MonthlyOverviewResponse): CockpitTopDerived {
  const totals = deriveTotals(data);
  const temSaldo = data.caixa?.temSaldoInicial ?? false;
  const caixaValor = temSaldo ? data.caixa!.hoje : totals.caixaAgora;

  const spark = (data.caixa?.porMes ?? []).map((p) => p.caixa);
  const caixaDelta =
    spark.length >= 2 ? spark[spark.length - 1]! - spark[spark.length - 2]! : 0;

  // Mês corrente e anterior a partir das linhas mensais.
  const sorted = [...data.meses].sort((a, b) => a.mes.localeCompare(b.mes));
  const idxAtual = sorted.findIndex((r) => r.mes === data.mesAtual);
  const rowAtual = idxAtual >= 0 ? sorted[idxAtual] : sorted[sorted.length - 1];
  const rowAnterior = idxAtual > 0 ? sorted[idxAtual - 1] : undefined;

  const resultadoEntrou = rowAtual?.recebimentosRealizados ?? 0;
  const resultadoGastou = rowAtual?.despesasRealizadas ?? 0;
  const resultadoMes = resultadoEntrou - resultadoGastou;
  const resultadoAnterior = rowAnterior
    ? rowAnterior.recebimentosRealizados - rowAnterior.despesasRealizadas
    : null;
  const resultadoDeltaPct =
    resultadoAnterior != null && resultadoAnterior !== 0
      ? ((resultadoMes - resultadoAnterior) / Math.abs(resultadoAnterior)) * 100
      : null;

  // A receber / a pagar do mês corrente (ainda não realizados).
  const aReceberMes = (rowAtual?.totalRecebimentos ?? 0) - resultadoEntrou;
  const aPagarMes = (rowAtual?.totalDespesas ?? 0) - resultadoGastou;
  const projecaoMes = caixaValor + aReceberMes - aPagarMes;

  // Fração do mês decorrida (para a barra de progresso do headline).
  const [y, m] = data.mesAtual.split('-').map((n) => parseInt(n, 10));
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const diasNoMes = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  let pctMesDecorrido = 1;
  if (data.mesAtual === nowKey) pctMesDecorrido = Math.min(now.getDate() / diasNoMes, 1);
  else if (data.mesAtual > nowKey) pctMesDecorrido = 0;

  return {
    caixaValor,
    caixaReal: temSaldo,
    caixaDelta,
    caixaSpark: spark,
    resultadoMes,
    resultadoEntrou,
    resultadoGastou,
    resultadoDeltaPct,
    projecaoMes,
    aReceberMes,
    aPagarMes,
    mesAtualKey: data.mesAtual,
    pctMesDecorrido,
  };
}

// ───────────── Eixo de caixa ("Vai sair"): reprojeta por vencimento ─────────────

/**
 * Reprojeta a resposta consolidada para o EIXO DE CAIXA (vencimento):
 * - despesas de cartão são remapeadas para a data de vencimento da fatura
 *   (via `caixaDateForCardPurchase`, usando closingDay/dueDay de `data.cards`);
 * - débitos de conta e recebimentos permanecem na competência;
 * - neutros pagos PELA CONTA (liquidação de fatura: `isNeutral && bankLast4`) são
 *   removidos (as compras já contaram nas faturas); mas neutro cobrado NO CARTÃO
 *   ("cartão paga cartão") é cobrança real na fatura e PERMANECE, remapeado para o
 *   vencimento — é o que faz o "Vai sair" bater com a Visão Conta (service:372).
 *
 * As linhas mensais (`meses`) são reconstruídas com o MESMO helper de domínio
 * usado no servidor (`buildMonthlyOverview`) — fonte única, sem cálculo novo.
 * O caixa real (§10, `data.caixa`) é preservado: o eixo muda QUANDO a saída
 * acontece, não o saldo reconciliado com o banco.
 */
export function buildCaixaData(data: MonthlyOverviewResponse): MonthlyOverviewResponse {
  const cardByLast4 = new Map((data.cards ?? []).map((c) => [c.last4, c] as const));

  const remap = (e: MonthlyEntry): MonthlyEntry | null => {
    if (e.tipo === 'DESPESA' && isNeutralAccountSettlement(e)) {
      return null; // liquidação pela conta: fora do eixo de caixa
    }
    if (e.tipo === 'DESPESA' && e.cardLast4) {
      const card = cardByLast4.get(e.cardLast4);
      const d = caixaDateForCardPurchase(e.data, card?.closingDay ?? null, card?.dueDay ?? null);
      return { ...e, data: d.toISOString() };
    }
    return e; // conta/recebimento: competência
  };

  const remappedEntries = (data.entries ?? [])
    .map(remap)
    .filter((e): e is MonthlyEntry => e !== null);

  const adapted: MonthlyOverviewEntry[] = remappedEntries
    .filter((e) => !e.isEspelho)
    .map((e) => ({
      tipo: e.tipo,
      valor: e.valor,
      status: e.status,
      data: e.data,
      categoria: e.categoria,
      projectOrigin: e.projectType,
    }));

  const meses = buildMonthlyOverview(adapted, { topCategorias: 6 }) as MonthlyOverviewRow[];
  const mesAtualEntries = remappedEntries.filter((e) => (e.data ?? '').slice(0, 7) === data.mesAtual);

  return { ...data, entries: remappedEntries, meses, mesAtualEntries };
}

export interface ComprometimentoItem {
  descricao: string;
  parcela: string | null;
  valor: number;
  cardLast4: string;
}

export interface ComprometimentoMes {
  mes: string; // YYYY-MM
  total: number;
  itens: ComprometimentoItem[];
}

/**
 * Trilha de comprometimento futuro: soma as saídas ainda NÃO realizadas
 * (status != PAGO/EM_CAIXA) de cartão por mês, já no eixo recebido pela tela
 * (`data` pode estar em competência ou caixa, conforme o toggle).
 */
export function buildComprometimentoFuturo(
  data: MonthlyOverviewResponse,
  fromMonth: string = data.mesAtual,
  maxMonths = 12,
): ComprometimentoMes[] {
  const byMonth = new Map<string, ComprometimentoMes>();

  for (const e of data.entries ?? []) {
    if (e.tipo !== 'DESPESA') continue;
    if (e.status === 'PAGO' || e.status === 'EM_CAIXA') continue;
    if (!e.cardLast4) continue;
    // Comprometimento futuro é saída de caixa: mantém neutro-no-cartão ("cartão paga
    // cartão" pendente = cobrança real na fatura). Só liquidação pela conta é excluída
    // (mas essas não têm cardLast4, então o filtro acima já as removeu).
    if (isNeutralAccountSettlement(e)) continue;

    const mes = (e.data ?? '').slice(0, 7);
    if (!mes || mes < fromMonth) continue;

    let bucket = byMonth.get(mes);
    if (!bucket) {
      bucket = { mes, total: 0, itens: [] };
      byMonth.set(mes, bucket);
    }
    bucket.total += e.valor;
    bucket.itens.push({
      descricao: e.subcategoria ?? e.categoria ?? 'Despesa',
      parcela: e.parcela ?? null,
      valor: e.valor,
      cardLast4: e.cardLast4,
    });
  }

  return Array.from(byMonth.values())
    .sort((a, b) => a.mes.localeCompare(b.mes))
    .slice(0, maxMonths);
}

// ─── Visão "Geral": extrato cronológico de saídas do mês ──────────────────────

export interface ExtratoItem {
  id: string;
  data: string;             // ISO da despesa
  dia: number;              // dia do mês (UTC)
  descricao: string;        // subcategoria → categoria → "Despesa"
  categoria: string;        // rótulo da categoria
  valor: number;            // centavos (saída)
  status: string;           // PAGO/EM_CAIXA = realizado; demais = planejado
  realizado: boolean;
  parcela: string | null;   // "k/n" quando parcelado
  formaPagamento: string | null;
  cardLast4: string | null; // origem cartão (null = conta/débito)
  projectName: string;      // origem (PESSOAL ou projeto vinculado)
  projectType: string;
  acumulado: number;        // soma acumulada das saídas até este item (centavos)
}

export interface ExtratoResumo {
  totalSaidas: number;      // todas as despesas do mês (realizado + planejado)
  totalRealizado: number;   // só PAGO/EM_CAIXA
  totalPlanejado: number;   // demais
  qtd: number;
}

export interface ExtratoMes {
  itens: ExtratoItem[];
  resumo: ExtratoResumo;
}

/**
 * Extrato de despesas do mês para a visão "Geral": todas as SAÍDAS do mês
 * (respeitando o filtro de data já aplicado pela página), em ordem cronológica
 * por data da despesa, com acumulado — um "fluxo de caixa" focado em saídas.
 *
 * Regras (coerentes com o eixo "Gastei"/competência — consumo real):
 * - apenas `tipo === 'DESPESA'`;
 * - espelhos cross-project são deduplicados (`isEspelho`) — o registro do
 *   projeto-alvo é o canônico, evitando dupla contagem;
 * - TODO tipo neutro (pagamento de fatura / movimentação interna, seja no cartão
 *   ou na conta) fica de fora, pois não representa consumo real;
 * - empates de data mantêm a ordem por maior valor (saída mais relevante antes).
 */
export function buildExtratoDespesas(entries: MonthlyEntry[]): ExtratoMes {
  const despesas = entries
    .filter((e) => e.tipo === 'DESPESA')
    .filter((e) => !e.isEspelho)
    .filter((e) => !entryIsNeutral(e));

  const ordenadas = [...despesas].sort((a, b) => {
    const da = a.data ?? '';
    const db = b.data ?? '';
    if (da !== db) return da < db ? -1 : 1;
    return b.valor - a.valor;
  });

  let acumulado = 0;
  let totalRealizado = 0;
  let totalPlanejado = 0;

  const itens: ExtratoItem[] = ordenadas.map((e) => {
    acumulado += e.valor;
    const realizado = isRealized(e.status);
    if (realizado) totalRealizado += e.valor;
    else totalPlanejado += e.valor;
    return {
      id: e.id,
      data: e.data,
      dia: dayOfMonth(e.data),
      descricao: e.subcategoria ?? e.categoria ?? 'Despesa',
      categoria: e.categoria ?? 'Outros',
      valor: e.valor,
      status: e.status,
      realizado,
      parcela: e.parcela ?? null,
      formaPagamento: e.formaPagamento ?? null,
      cardLast4: e.cardLast4 ?? null,
      projectName: e.projectName ?? '',
      projectType: e.projectType ?? '',
      acumulado,
    };
  });

  return {
    itens,
    resumo: {
      totalSaidas: totalRealizado + totalPlanejado,
      totalRealizado,
      totalPlanejado,
      qtd: itens.length,
    },
  };
}
