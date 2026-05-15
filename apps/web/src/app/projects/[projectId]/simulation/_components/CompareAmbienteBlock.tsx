'use client';

import React, { useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import type { SimAmbiente, SimTipo } from '../_types';

export function CompareAmbienteBlock({ amb, ambTotalA, ambTotalB, ambDiff, tipoRows }: {
  amb: SimAmbiente;
  ambTotalA: number;
  ambTotalB: number;
  ambDiff: number;
  tipoRows: Array<SimTipo & { vA: number; vB: number; catRows?: Array<{ key: string; label: string; total: number; vA: number; vB: number }> }>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="bg-orange-50/50 cursor-pointer hover:bg-orange-100/50" onClick={() => setExpanded(!expanded)}>
        <td className="px-3 py-1.5 font-semibold">
          <span className="mr-1 text-gray-400">{expanded ? '▾' : '▸'}</span>
          {amb.label}
        </td>
        <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(amb.total / 100)}</td>
        <td className="px-3 py-1.5 text-right text-blue-700 font-medium">{formatCurrency(ambTotalA / 100)}</td>
        <td className="px-3 py-1.5 text-right text-purple-700 font-medium">{formatCurrency(ambTotalB / 100)}</td>
        <td className={`px-3 py-1.5 text-right ${ambDiff > 0 ? 'text-green-600' : ambDiff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
          {ambDiff !== 0 ? `${ambDiff > 0 ? '+' : ''}${formatCurrency(ambDiff / 100)}` : '—'}
        </td>
      </tr>
      {expanded && tipoRows.map((tipo) => {
        const diff = tipo.vA - tipo.vB;
        return (
          <tr key={tipo.key} className="hover:bg-gray-50">
            <td className="px-3 py-1 pl-8 text-gray-600">{tipo.label}</td>
            <td className="px-3 py-1 text-right text-gray-500">{formatCurrency(tipo.total / 100)}</td>
            <td className="px-3 py-1 text-right text-blue-600">{formatCurrency(tipo.vA / 100)}</td>
            <td className="px-3 py-1 text-right text-purple-600">{formatCurrency(tipo.vB / 100)}</td>
            <td className={`px-3 py-1 text-right ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
              {diff !== 0 ? `${diff > 0 ? '+' : ''}${formatCurrency(diff / 100)}` : '—'}
            </td>
          </tr>
        );
      })}
    </>
  );
}
