'use client';

import { CalendarClock, PlusCircle, Sparkles } from 'lucide-react';
import { Card } from './ui';
import { fmtMoney, mesCurto } from './format';
import type { ComprometimentoMes } from './derive';
import { NovaDespesaLauncher } from '../../expenses/_components/NovaDespesaLauncher';

function labelMes(key: string): string {
  const [y, m] = key.split('-').map((n) => Number.parseInt(n, 10));
  return `${mesCurto((m || 1) - 1)}/${String(y || 0).slice(-2)}`;
}

/**
 * Coluna direita do cockpit desktop (D1): atalho de lançamento (reusa o
 * `NovaDespesaLauncher` canônico, sem via de mutação própria), os próximos
 * vencimentos de cartão (comprometimento futuro já computado por
 * `MonthView`/`buildComprometimentoFuturo`) e o placeholder estático do
 * assistente "Maria" — sem LLM/rede nesta trilha.
 */
export function DesktopRail({
  projectId,
  projectType,
  comprometimento,
}: {
  projectId: string;
  projectType: string;
  comprometimento: ComprometimentoMes[];
}) {
  const proximos = comprometimento
    .flatMap((mes) => mes.itens.map((item) => ({ ...item, mes: mes.mes })))
    .slice(0, 8);

  return (
    <div className="space-y-4">
      <Card>
        <NovaDespesaLauncher
          projectId={projectId}
          projectType={projectType}
          trigger={(open) => (
            <button
              type="button"
              onClick={open}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--ck-accent)] px-3 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            >
              <PlusCircle className="h-4 w-4" /> Lançar agora
            </button>
          )}
        />
      </Card>

      <Card
        title={
          <>
            <CalendarClock className="h-3.5 w-3.5" /> Próximos vencimentos
          </>
        }
        hint="cartão · comprometimento futuro"
      >
        {proximos.length === 0 ? (
          <p className="text-xs text-[var(--ck-muted)]">Nenhum vencimento futuro no cartão.</p>
        ) : (
          <ul className="space-y-2">
            {proximos.map((item, i) => (
              <li
                key={`${item.mes}-${item.descricao}-${i}`}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate text-[var(--ck-text)]">
                  <span>{item.descricao}</span>
                  {item.parcela && <span className="text-[var(--ck-muted)]"> · {item.parcela}</span>}
                </span>
                <span className="shrink-0 font-geist tabular-nums text-[var(--ck-muted)]">
                  {fmtMoney(item.valor)} · {labelMes(item.mes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={
          <>
            <Sparkles className="h-3.5 w-3.5" /> Maria
          </>
        }
        hint="em breve"
      >
        <p className="text-xs text-[var(--ck-muted)]">
          O assistente Maria vai responder perguntas sobre seu orçamento numa próxima versão.
        </p>
      </Card>
    </div>
  );
}
