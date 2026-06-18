'use client';
import { Layers, Wallet } from 'lucide-react';

export type ExpenseEixo = 'competencia' | 'caixa';

const OPTS: { key: ExpenseEixo; label: string; hint: string }[] = [
  {
    key: 'competencia',
    label: 'Visão Gastos Controle',
    hint: 'tudo que comprei no mês vigente, pela data da compra.',
  },
  {
    key: 'caixa',
    label: 'Visão Conta Real',
    hint: 'o que vai sair efetivamente da conta neste mês: faturas dos cartões (por vencimento) + débitos.',
  },
];

/**
 * Interruptor de eixo da tela de despesas do PESSOAL: competência (Gastos
 * Controle, padrão) × caixa (Conta Real). Abaixo, um texto explica a visão
 * ativa e troca ao clicar.
 */
export function ExpenseEixoToggle({
  eixo,
  onChange,
}: {
  eixo: ExpenseEixo;
  onChange: (e: ExpenseEixo) => void;
}) {
  const hint = OPTS.find((o) => o.key === eixo)?.hint ?? '';
  return (
    <div className="space-y-1.5">
      <div
        role="group"
        aria-label="Visão da conta"
        className="inline-flex rounded-lg border border-violet-200 overflow-hidden"
      >
        {OPTS.map((o, i) => {
          const active = eixo === o.key;
          const Icon = o.key === 'competencia' ? Layers : Wallet;
          return (
            <button
              key={o.key}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.key)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                i > 0 ? 'border-l border-violet-200' : ''
              } ${active ? 'bg-violet-500 text-white' : 'bg-white text-violet-700 hover:bg-violet-50'}`}
            >
              <Icon className="w-3.5 h-3.5" /> {o.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-gray-500">{hint}</p>
    </div>
  );
}
