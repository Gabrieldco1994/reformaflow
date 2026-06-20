'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const MES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function saudacao(d = new Date()): string {
  const h = d.getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** Rótulo curto do período: 'ALL' → "Ano", 'YYYY-MM' → "Jun 26". */
function chipLabel(period: string): string {
  if (period === 'ALL') return 'Ano';
  const [yy, mm] = period.split('-').map(Number);
  return `${MES_CURTO[mm - 1]} ${String(yy).slice(-2)}`;
}

/**
 * Cabeçalho editorial da tela de despesas do PESSOAL (estilo de referência):
 * saudação + título grande + chip de mês com navegação ◂ ▸. Substitui o título
 * simples no PESSOAL, mantendo a paleta (acento laranja).
 */
export function PersonalMonthHeader({
  title,
  userName,
  period,
  onPrev,
  onNext,
}: {
  title: string;
  userName?: string | null;
  period: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const primeiroNome = (userName ?? '').trim().split(/\s+/)[0];
  const isAll = period === 'ALL';
  return (
    <div className="flex w-full items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-darc-velvet/50">
          {saudacao()}{primeiroNome ? `, ${primeiroNome}` : ''}
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-darc-velvet">{title}</h1>
      </div>
      <div className="flex items-center gap-1 rounded-full border border-darc-linen bg-white px-1 py-0.5 shadow-darc-soft shrink-0">
        <button
          type="button"
          onClick={onPrev}
          disabled={isAll}
          aria-label="Mês anterior"
          className="rounded-full p-1.5 text-darc-velvet/60 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-30 transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-[3.5rem] text-center text-sm font-bold text-darc-velvet">{chipLabel(period)}</span>
        <button
          type="button"
          onClick={onNext}
          disabled={isAll}
          aria-label="Próximo mês"
          className="rounded-full p-1.5 text-darc-velvet/60 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-30 transition-colors"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
