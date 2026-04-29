'use client';

import { formatCurrency, formatPercent } from '@/lib/utils';
import { DollarSign, TrendingDown, TrendingUp, Percent } from 'lucide-react';

interface KpiCardsProps {
  totalPlanned: number;
  totalActual: number;
  totalBalance: number;
  percentConsumed: number;
}

export function KpiCards({ totalPlanned, totalActual, totalBalance, percentConsumed }: KpiCardsProps) {
  const cards = [
    {
      label: 'Orçamento Previsto',
      value: formatCurrency(totalPlanned),
      icon: DollarSign,
      color: 'text-blue-600 bg-blue-50',
    },
    {
      label: 'Total Gasto',
      value: formatCurrency(totalActual),
      icon: TrendingDown,
      color: 'text-red-600 bg-red-50',
    },
    {
      label: 'Saldo Disponível',
      value: formatCurrency(totalBalance),
      icon: TrendingUp,
      color: totalBalance >= 0 ? 'text-green-600 bg-green-50' : 'text-red-600 bg-red-50',
    },
    {
      label: '% Consumido',
      value: formatPercent(percentConsumed),
      icon: Percent,
      color: percentConsumed > 1
        ? 'text-red-600 bg-red-50'
        : percentConsumed >= 0.8
        ? 'text-yellow-600 bg-yellow-50'
        : 'text-green-600 bg-green-50',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm"
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${card.color}`}>
                <Icon className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {card.label}
                </p>
                <p className="text-lg font-bold text-gray-900 mt-0.5">
                  {card.value}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
