'use client';

import { TrendingUp, AlertTriangle, CalendarClock, Shield } from 'lucide-react';
import { Card } from './ui';
import { fmtMoney } from './format';
import type { MonthDerived } from './derive';

export default function Recomendacoes({
  m,
  saldoProjetadoVal,
}: {
  m: MonthDerived;
  saldoProjetadoVal: number;
}) {
  const equilibrado = saldoProjetadoVal >= m.saldoInicial;
  const deficit = m.saldoInicial - saldoProjetadoVal;
  const cortePorDia = m.diasRestantes > 0 ? deficit / m.diasRestantes : deficit;

  const contas = [...m.contasFuturas].sort((a, b) => a.dia - b.dia).slice(0, 4);

  return (
    <Card title="Recomendações">
      <ul className="space-y-3">
        <li className="flex gap-2.5">
          {equilibrado ? (
            <TrendingUp className="w-4 h-4 mt-0.5 shrink-0 text-[var(--ck-pos)]" />
          ) : (
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--ck-neg)]" />
          )}
          <p className="text-xs text-[var(--ck-text)] leading-relaxed">
            {equilibrado ? (
              <>
                No ritmo atual você fecha o mês com{' '}
                <strong className="text-[var(--ck-pos)] font-geist tabular-nums">{fmtMoney(saldoProjetadoVal)}</strong>, acima de como começou.
              </>
            ) : (
              <>
                Projeção de fechar em{' '}
                <strong className="text-[var(--ck-neg)] font-geist tabular-nums">{fmtMoney(saldoProjetadoVal)}</strong>. Para equilibrar,
                corte{' '}
                <strong className="text-[var(--ck-alert)] font-geist tabular-nums">{fmtMoney(cortePorDia)}</strong>/dia nos{' '}
                {m.diasRestantes} dias restantes.
              </>
            )}
          </p>
        </li>

        {m.maiorGastoVariavel && (
          <li className="flex gap-2.5">
            <span
              className="w-4 h-4 mt-0.5 shrink-0 rounded-sm"
              style={{ background: m.maiorGastoVariavel.cor }}
            />
            <p className="text-xs text-[var(--ck-text)] leading-relaxed">
              Maior gasto variável: <strong>{m.maiorGastoVariavel.categoria}</strong> com{' '}
              <strong className="font-geist tabular-nums">{fmtMoney(m.maiorGastoVariavel.valor)}</strong>. Vale revisar.
            </p>
          </li>
        )}

        {contas.length > 0 && (
          <li className="flex gap-2.5">
            <CalendarClock className="w-4 h-4 mt-0.5 shrink-0 text-[var(--ck-alert)]" />
            <div className="text-xs text-[var(--ck-text)] leading-relaxed">
              <span className="text-[var(--ck-muted)]">Contas a vencer:</span>
              <ul className="mt-1 space-y-0.5">
                {contas.map((c, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span>dia {c.dia} · {c.nome}</span>
                    <span className="font-geist tabular-nums text-[var(--ck-neg)]">{fmtMoney(c.valor)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        )}

        <li className="flex gap-2.5">
          <Shield className={`w-4 h-4 mt-0.5 shrink-0 ${m.reservaMeses >= m.reservaMeta ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-alert)]'}`} />
          <p className="text-xs text-[var(--ck-text)] leading-relaxed">
            Reserva de emergência:{' '}
            <strong className="font-geist tabular-nums">{m.reservaMeses.toFixed(1).replace('.', ',')}</strong> de{' '}
            {m.reservaMeta} meses de despesa{' '}
            {m.reservaMeses >= m.reservaMeta ? (
              <span className="text-[var(--ck-pos)]">— meta atingida ✓</span>
            ) : (
              <span className="text-[var(--ck-alert)]">— abaixo da meta</span>
            )}
            .
          </p>
        </li>
      </ul>
    </Card>
  );
}
