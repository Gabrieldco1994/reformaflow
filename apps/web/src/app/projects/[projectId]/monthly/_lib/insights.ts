import type { CategoriaBarra, ComprometimentoMes } from "../_cockpit/derive";

/**
 * "Maria percebeu" — insights derivados por regra pura de dados JÁ
 * calculados no cockpit (sem chamada de IA nesta fase). Determinístico: o
 * mesmo input sempre produz o mesmo output (nada de `Date.now()`/`Math.random`).
 */
export type MariaInsight =
  | {
      kind: "categoria-alta";
      categoria: string;
      valorMes: number;
      valorMedia: number;
      deltaPct: number;
    }
  | {
      kind: "categoria-economia";
      categoria: string;
      valorMes: number;
      valorMedia: number;
      deltaPct: number;
    }
  | {
      kind: "parcela-fim";
      mes: string;
      valorLiberado: number;
      descricao: string;
    };

/** Limiar de desvio (15%) acima/abaixo da média mensal para virar insight. */
const THRESHOLD_PCT = 0.15;

function buildCategoriaInsights(
  categorias: CategoriaBarra[],
  mediaMensalPorTipo: Map<string, number>,
): MariaInsight[] {
  const insights: MariaInsight[] = [];
  for (const cat of categorias) {
    const valorMedia = mediaMensalPorTipo.get(cat.categoria) ?? 0;
    // Guarda contra divisão por zero / histórico ausente — sem média confiável,
    // não há insight de desvio (evita NaN/Infinity).
    if (valorMedia <= 0) continue;
    const deltaPct = (cat.valor - valorMedia) / valorMedia;
    if (deltaPct > THRESHOLD_PCT) {
      insights.push({
        kind: "categoria-alta",
        categoria: cat.categoria,
        valorMes: cat.valor,
        valorMedia,
        deltaPct,
      });
    } else if (deltaPct < -THRESHOLD_PCT) {
      insights.push({
        kind: "categoria-economia",
        categoria: cat.categoria,
        valorMes: cat.valor,
        valorMedia,
        deltaPct,
      });
    }
  }
  return insights;
}

/**
 * Detecta o fim de uma parcela comparando dois meses CONSECUTIVOS de
 * comprometimento (ordenados ascendente por `mes`, conforme
 * `buildComprometimentoFuturo`): quando o total do próximo mês cai, o valor
 * liberado é a diferença — e a descrição vem do item do mês atual que some
 * (ou tem a maior queda de valor) no mês seguinte.
 */
function buildParcelaFimInsights(
  comprometimento: ComprometimentoMes[],
): MariaInsight[] {
  const insights: MariaInsight[] = [];
  for (let i = 0; i < comprometimento.length - 1; i++) {
    const atual = comprometimento[i]!;
    const proximo = comprometimento[i + 1]!;
    const valorLiberado = atual.total - proximo.total;
    if (valorLiberado <= 0) continue;

    // Item presente no mês atual e ausente (ou com valor menor) no próximo mês —
    // primeiro candidato pelo valor mais próximo do liberado.
    const candidato =
      atual.itens.find((item) => {
        const aindaPresente = proximo.itens.some(
          (proxItem) =>
            proxItem.descricao === item.descricao &&
            proxItem.cardLast4 === item.cardLast4,
        );
        return !aindaPresente;
      }) ?? atual.itens[0];

    if (!candidato) continue;

    insights.push({
      kind: "parcela-fim",
      mes: proximo.mes,
      valorLiberado,
      descricao: candidato.descricao,
    });
  }
  return insights;
}

export function buildMariaStories(input: {
  categorias: CategoriaBarra[];
  mediaMensalPorTipo: Map<string, number>;
  comprometimento: ComprometimentoMes[];
}): MariaInsight[] {
  return [
    ...buildCategoriaInsights(input.categorias, input.mediaMensalPorTipo),
    ...buildParcelaFimInsights(input.comprometimento),
  ];
}
