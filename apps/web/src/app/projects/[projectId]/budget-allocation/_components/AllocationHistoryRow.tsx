'use client';

import { ArrowLeftRight } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { REDACTED_PROJECT_LABEL } from './redacted-project';

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/**
 * `dd mmm` em UTC, mesma fatia de string do `dateParts` do `MovimentacaoRow`.
 *
 * Fatiar o ISO em vez de `new Date(...).toLocaleDateString` é deliberado: a
 * data de alocação é um marco de escrituração, não um instante, e converter
 * para o fuso do navegador faz `2026-07-01T00:00Z` virar 30/jun em São Paulo.
 */
function dayMonth(value: string): string {
  const [, m, d] = (value ?? '').slice(0, 10).split('-');
  const mi = parseInt(m ?? '', 10);
  const dia = (d ?? '').padStart(2, '0') || '--';
  const mes = mi >= 1 && mi <= 12 ? MESES_ABREV[mi - 1] : '';
  return mes ? `${dia} ${mes}` : dia;
}

/** `2026-07` → `ref. jul/2026`: o mês de competência vira texto, não coluna. */
function refLabel(mes: string): string {
  const [y, m] = (mes ?? '').split('-');
  const mi = parseInt(m ?? '', 10);
  return mi >= 1 && mi <= 12 ? `ref. ${MESES_ABREV[mi - 1]}/${y}` : `ref. ${mes}`;
}

export interface AllocationHistoryItem {
  id: string;
  dataAlocacao: string;
  mes: string;
  valor: number;
  descricao?: string | null;
  targetProject?: { id?: string; name?: string } | null;
}

/**
 * #490 / D-D — a linha do histórico congelado abaixo de `sm`.
 *
 * POR QUE NÃO É TABELA AQUI. A 375px o scroller da tabela media clientWidth
 * 269 contra scrollWidth 372: a coluna "Valor" nascia 103px fora e só ficava
 * legível depois de arrastar na horizontal. Não era ajuste de largura — o
 * `min-content` da tabela com dados reais é ~372px e, zerando TODO o padding
 * disponível (card `p-4` + `main` 20px/lado), o espaço útil chega a 341px.
 * Faltavam 31px que não existiam em lugar nenhum.
 *
 * O QUE RESOLVE. A anatomia do `MovimentacaoRow` (layout canônico de linha
 * financeira): o texto longo fica em `min-w-0 flex-1` e CEDE espaço; o valor
 * fica `shrink-0 whitespace-nowrap` e NUNCA cede. Uma tabela não consegue
 * isso — o `min-content` dela é a soma dos `min-content` das colunas e
 * nenhuma delas pode encolher a favor da outra.
 *
 * A POLÍTICA DE CORTE NÃO É GOSTO, É O PROPÓSITO DA TELA. O nome do projeto
 * usa `line-clamp-2` (e não `truncate`) porque, numa trilha de auditoria,
 * **você troca "não sei quanto" por "não sei para quem"** — as duas perdas são
 * reais, mas o valor é a carga útil de um histórico somente-leitura, então
 * quem cede é o rótulo. Com `truncate` de uma linha, "Apartamento
 * Higienópolis" recebia 93px dos 180px que precisa; com duas linhas, cabe.
 * Trocar por `truncate` "para ficar igual ao desktop" reabre o defeito.
 *
 * NADA SAI. Data, projeto, mês de referência e descrição continuam todos na
 * linha: num histórico congelado, remover campo é decisão de dado, não de
 * layout. O que muda é peso — o valor sobe, o resto vira apoio.
 */
export function AllocationHistoryRow({ allocation }: { allocation: AllocationHistoryItem }) {
  const redacted = !allocation.targetProject?.name;
  const titulo = allocation.targetProject?.name ?? REDACTED_PROJECT_LABEL;
  const meta = [dayMonth(allocation.dataAlocacao), refLabel(allocation.mes), allocation.descricao]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      data-allocation-row
      className="rounded-xl border border-lifeone-hairline bg-lifeone-card"
    >
      <div className="flex items-start gap-2.5 px-2.5 py-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#EFE6FA] text-[#7A3FC2]">
          <ArrowLeftRight className="h-4 w-4" />
        </span>

        {/* Texto flexível: é ELE que cede espaço, nunca o valor. */}
        <div className="min-w-0 flex-1">
          <p
            className={`line-clamp-2 pr-1 text-[14px] font-semibold leading-tight ${
              redacted ? 'italic text-lifeone-ink-3' : 'text-lifeone-ink'
            }`}
          >
            {titulo}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-lifeone-ink-3">{meta}</p>
        </div>

        {/* Valor isolado: `shrink-0` + `whitespace-nowrap` = a garantia de que nunca corta. */}
        <div className="flex shrink-0 flex-col items-end gap-0">
          <span className="whitespace-nowrap font-geist text-[14px] font-semibold tabular-nums text-lifeone-ink">
            {formatCurrency(allocation.valor / 100)}
          </span>
        </div>
      </div>
    </div>
  );
}
