'use client';

import type { ScheduleConfig, ScheduleKPIs } from '../_types';
import { fmtCurrency, fmtDate, daysBetween } from '../_lib/format';

export function KPICards({
  kpis,
  config,
}: {
  kpis: ScheduleKPIs;
  config: ScheduleConfig | null;
}) {
  const today = new Date();
  const terminoPrevisto = kpis.terminoPrevisto ? new Date(kpis.terminoPrevisto) : null;
  const diasAtraso = terminoPrevisto && terminoPrevisto < today ? daysBetween(terminoPrevisto, today) : 0;

  // Visual feedback — config is unused but kept for parity with the original API.
  void config;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
      <div className="bg-white rounded-lg border p-3">
        <div className="text-xs text-gray-500">% Concluído</div>
        <div className="text-xl font-bold text-brand-700">{kpis.percentualTotal}%</div>
        <div className="mt-1 bg-gray-200 rounded-full h-1.5">
          <div
            className="bg-brand-600 h-1.5 rounded-full transition-all"
            style={{ width: `${kpis.percentualTotal}%` }}
          />
        </div>
      </div>
      <div className="bg-white rounded-lg border p-3">
        <div className="text-xs text-gray-500">Total Orçado</div>
        <div className="text-lg font-bold text-gray-800">{fmtCurrency(kpis.totalOrcado)}</div>
      </div>
      <div className="bg-white rounded-lg border p-3">
        <div className="text-xs text-gray-500">Custo Real</div>
        <div className="text-lg font-bold text-gray-800">{fmtCurrency(kpis.totalReal)}</div>
      </div>
      <div
        className={`bg-white rounded-lg border p-3 ${
          kpis.totalDesvio > 0 ? 'border-red-300' : kpis.totalDesvio < 0 ? 'border-green-300' : ''
        }`}
      >
        <div className="text-xs text-gray-500">Desvio</div>
        <div
          className={`text-lg font-bold ${
            kpis.totalDesvio > 0 ? 'text-red-600' : kpis.totalDesvio < 0 ? 'text-green-600' : 'text-gray-600'
          }`}
        >
          {fmtCurrency(kpis.totalDesvio)}
        </div>
      </div>
      <div className="bg-white rounded-lg border p-3">
        <div className="text-xs text-gray-500">Término Previsto</div>
        <div className="text-lg font-bold text-gray-800">
          {terminoPrevisto ? fmtDate(kpis.terminoPrevisto) : '-'}
        </div>
      </div>
      <div className={`bg-white rounded-lg border p-3 ${diasAtraso > 0 ? 'border-red-300 bg-red-50' : ''}`}>
        <div className="text-xs text-gray-500">Dias de Atraso</div>
        <div className={`text-lg font-bold ${diasAtraso > 0 ? 'text-red-600' : 'text-green-600'}`}>
          {diasAtraso > 0 ? diasAtraso : '0'}
        </div>
      </div>
    </div>
  );
}
