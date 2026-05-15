'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import type { Expense } from '@/types';
import type { PriceResult } from '../_types';

export function PriceCompareModal({ open, onClose, expense }: { open: boolean; onClose: () => void; expense: Expense }) {
  const searchQuery = expense.titulo || '';
  const { data: results = [], isLoading, error } = useQuery<PriceResult[]>({
    queryKey: ['price-compare', searchQuery],
    queryFn: () => api.get(`/price-compare?q=${encodeURIComponent(searchQuery)}`),
    enabled: open && searchQuery.length >= 3,
    staleTime: 1000 * 60 * 60 * 24,
    retry: 1,
  });

  const currentPrice = expense.valorTotal / 100;

  const getPriceIndicator = (price: number | null) => {
    if (!price) return { color: 'text-gray-400', bg: 'bg-gray-100', label: '—' };
    const diff = ((price - currentPrice) / currentPrice) * 100;
    if (diff < -5) return { color: 'text-green-700', bg: 'bg-green-100', label: `${diff.toFixed(0)}%` };
    if (diff > 5) return { color: 'text-red-700', bg: 'bg-red-100', label: `+${diff.toFixed(0)}%` };
    return { color: 'text-yellow-700', bg: 'bg-yellow-100', label: '~igual' };
  };

  return (
    <Modal open={open} onClose={onClose} title="Comparar Preços">
      <div className="space-y-4">
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
          <p className="text-xs text-orange-600 font-medium">Seu preço atual</p>
          <p className="text-lg font-bold text-orange-800">{formatCurrency(currentPrice)}</p>
          <p className="text-xs text-orange-500 mt-0.5 line-clamp-1">{expense.titulo || 'Sem título'}</p>
        </div>

        {!searchQuery || searchQuery.length < 3 ? (
          <p className="text-sm text-gray-500 text-center py-4">
            Adicione um título à despesa para comparar preços
          </p>
        ) : isLoading ? (
          <div className="flex flex-col items-center py-8 gap-2">
            <div className="w-6 h-6 border-2 border-orange-300 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-gray-400">Buscando preços...</p>
          </div>
        ) : error ? (
          <p className="text-sm text-red-500 text-center py-4">Erro ao buscar preços. Verifique as credenciais Google CSE.</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">
            Nenhum resultado encontrado. Tente editar o título da despesa para ser mais descritivo.
          </p>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {results.map((r, i) => {
              const indicator = getPriceIndicator(r.price);
              return (
                <a
                  key={i}
                  href={r.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-2.5 border rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {r.image && (
                    <img src={r.image} alt="" className="w-10 h-10 object-contain rounded" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-800 line-clamp-1">{r.title}</p>
                    <p className="text-[10px] text-gray-400">{r.store}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {r.price ? (
                      <>
                        <p className="text-sm font-bold text-gray-900">{formatCurrency(r.price)}</p>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${indicator.bg} ${indicator.color}`}>
                          {indicator.label}
                        </span>
                      </>
                    ) : (
                      <p className="text-xs text-gray-400">Preço indisponível</p>
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        )}

        <p className="text-[10px] text-gray-400 text-center">
          Resultados via Google Shopping • Preços podem variar
        </p>
      </div>
    </Modal>
  );
}

