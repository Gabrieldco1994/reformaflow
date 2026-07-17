'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hasFeature, type ProjectType } from '@reformaflow/domain';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { ExternalLink, ShoppingCart, BarChart3 } from 'lucide-react';
import type { Expense } from '@/types';
import type { LinkPreview } from '../_types';
import { StatusBadge } from './StatusBadge';
import { PriceCompareModal } from './PriceCompareModal';

export function LinkPreviewCard({ expense, tipoLabel }: { expense: Expense; tipoLabel: (t: string) => string }) {
  const { projectType } = useProject();
  const [imgError, setImgError] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const canUsePriceCompare = hasFeature(projectType as ProjectType, 'priceCompare');
  const { data: preview, isLoading } = useQuery<LinkPreview>({
    queryKey: ['link-preview', expense.link],
    queryFn: () => api.get(`/link-preview?url=${encodeURIComponent(expense.link!)}`),
    staleTime: 1000 * 60 * 60 * 24, // 24h cache
    retry: 1,
    enabled: !!expense.link,
  });

  const title = expense.titulo || preview?.ogTitle || 'Sem título';
  // Priority: manual imageUrl > auto-detected ogImage
  const imageSource = expense.imageUrl || (preview?.ogImage && !imgError ? preview.ogImage : null);
  const hasImage = !!imageSource && !imgError;
  let domain = '';
  try { domain = new URL(expense.link!).hostname.replace('www.', ''); } catch {}

  return (
    <>
      <div className="border rounded-xl overflow-hidden bg-white shadow-sm hover:shadow-md transition-all group flex flex-col">
        {/* Image area */}
        <div className="relative h-32 sm:h-56 bg-gray-100 overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="w-6 h-6 border-2 border-orange-300 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : hasImage ? (
            <img
              src={imageSource!}
              alt={title}
              className="w-full h-full object-contain p-2 group-hover:scale-105 transition-transform duration-300"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full bg-gradient-to-br from-gray-50 to-gray-200">
              {preview?.favicon ? (
                <img src={preview.favicon} alt="" className="w-12 h-12 rounded-lg shadow-sm mb-2" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              ) : (
                <ShoppingCart className="w-10 h-10 text-gray-300 mb-2" />
              )}
              <p className="text-xs text-gray-400 font-medium">{domain}</p>
            </div>
          )}
          {/* Status badge overlay */}
          <div className="absolute top-2 right-2">
            <StatusBadge status={expense.status} />
          </div>
          {/* Favicon on image */}
          {hasImage && preview?.favicon && (
            <div className="absolute bottom-2 left-2 w-6 h-6 rounded-md bg-white/90 p-0.5 shadow-sm backdrop-blur-sm">
              <img src={preview.favicon} alt="" className="w-full h-full object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-2 sm:p-3 flex-1 flex flex-col gap-1 sm:gap-1.5">
          <h3 className="font-semibold text-[11px] sm:text-sm text-gray-800 line-clamp-2 leading-snug">{title}</h3>
          {preview?.ogDescription && (
            <p className="hidden sm:block text-[10px] text-gray-400 line-clamp-2">{preview.ogDescription}</p>
          )}

          <div className="flex flex-wrap gap-1 mt-0.5 sm:mt-1">
            <span className="text-[9px] sm:text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">{tipoLabel(expense.tipoDespesa)}</span>
            {expense.room?.name && (
              <span className="hidden sm:inline text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">{expense.room.name}</span>
            )}
          </div>

          {expense.fornecedor && (
            <p className="hidden sm:block text-[10px] text-gray-500">🏪 {expense.fornecedor}</p>
          )}

          <div className="mt-auto pt-1.5 sm:pt-2 flex items-end justify-between border-t border-gray-100">
            <div className="min-w-0">
              <p className="hidden sm:block text-xs text-gray-400">Valor total</p>
              <p className="text-sm sm:text-base font-bold text-gray-900 truncate">{formatCurrency(expense.valorTotal / 100)}</p>
              {expense.quantidade > 1 && (
                <p className="hidden sm:block text-[10px] text-gray-400">{expense.quantidade}x {formatCurrency(expense.valor / 100)}</p>
              )}
            </div>
            <div className="flex gap-1 sm:gap-1.5 shrink-0">
              {canUsePriceCompare && (
                <button
                  onClick={() => setCompareOpen(true)}
                  className="inline-flex items-center gap-1 px-1.5 sm:px-2.5 py-1 sm:py-1.5 bg-purple-100 text-purple-700 text-xs font-medium rounded-lg hover:bg-purple-200 transition-colors"
                  title="Comparar preços"
                >
                  <BarChart3 className="w-3 h-3" />
                </button>
              )}
              <a
                href={expense.link!}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 bg-orange-500 text-white text-xs font-medium rounded-lg hover:bg-orange-600 transition-colors"
              >
                <ExternalLink className="w-3 h-3" /> <span className="hidden sm:inline">Abrir</span>
              </a>
            </div>
          </div>
        </div>
      </div>
      {canUsePriceCompare && (
        <PriceCompareModal open={compareOpen} onClose={() => setCompareOpen(false)} expense={expense} />
      )}
    </>
  );
}
