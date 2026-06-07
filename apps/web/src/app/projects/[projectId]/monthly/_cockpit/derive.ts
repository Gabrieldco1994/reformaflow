import type { MonthlyOverviewResponse, MonthlyOverviewRow, MonthlyEntry } from '../_types';

/** Categorias com cor fixa (significado consistente em todo o cockpit). */
export const CAT_COLORS: Record<string, string> = {
  Moradia: '#6ee7d8',
  Alimentação: '#4fd1a5',
  Transporte: '#ffc14d',
  Lazer: '#a78bfa',
  Saúde: '#ff6b7d',
  Receita: '#4fd1a5',
};
const CAT_PALETTE = ['#6ee7d8', '#4fd1a5', '#ffc14d', '#a78bfa', '#ff6b7d', '#60a5fa', '#f59e0b', '#34d399'];

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
  let saldoInicial = 0;
  for (const r of data.meses) {
    if (r.mes >= mesAtualKey) continue;
    if (r.mes < nowKey) saldoInicial += r.saldoMesRealizado;
    else saldoInicial += r.saldoMes;
  }

  let gasteiRealizado = 0;
  let gasteiPlanejado = 0;
  let entrouRealizado = 0;
  let entrouPrevisto = 0;
  let variavelRealizadoAteHoje = 0;

  const agendadosPorDia = new Map<number, number>();
  const contasFuturas: ContaFutura[] = [];

  for (const e of entries) {
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

  const saldoAtual = saldoInicial + entrouRealizado - gasteiRealizado;
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
    saldoInicial, saldoAtual, gasteiRealizado, gasteiPlanejado, entrouRealizado, entrouPrevisto,
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
