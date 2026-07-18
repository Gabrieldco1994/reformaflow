'use client';

import { formatDateBR } from '@/lib/utils';
import { Droplets, Sun, Scissors, Leaf, Wind, AlertTriangle, Heart, Zap, Clock } from 'lucide-react';
import type { PlantInsightsResponse } from '../_types';

interface PlantInsightsPanelProps {
  insights: PlantInsightsResponse;
  isLoading?: boolean;
  isError?: boolean;
}

// Badge color mapping constants
const SAUDE_BADGE: Record<string, string> = {
  SAUDAVEL: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  ATENCAO: 'bg-amber-50 text-amber-700 border border-amber-200',
  CRITICA: 'bg-red-50 text-red-700 border border-red-200',
};

const PET_BADGE: Record<string, string> = {
  SEGURO: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  CAUTELA: 'bg-amber-50 text-amber-700 border border-amber-200',
  TOXICA: 'bg-red-50 text-red-700 border border-red-200',
  DESCONHECIDO: 'bg-slate-50 text-slate-700 border border-slate-200',
};

const GRAVIDADE_BADGE: Record<string, string> = {
  LEVE: 'bg-blue-50 text-blue-700 border border-blue-200',
  MEDIA: 'bg-amber-50 text-amber-700 border border-amber-200',
  GRAVE: 'bg-red-50 text-red-700 border border-red-200',
};

const STATUS_BADGE: Record<string, string> = {
  PENDENTE: 'bg-slate-50 text-slate-700 border border-slate-200',
  CONCLUIDO: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  CANCELADO: 'bg-red-50 text-red-700 border border-red-200',
};

const CARE_ICONS = {
  rega: Droplets,
  luz: Sun,
  poda: Scissors,
  adubacao: Leaf,
  solo: Wind,
};

function formatCurrencyBR(centavos: number): string {
  const reais = (centavos / 100).toFixed(2);
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(reais));
}

export function PlantInsightsPanel({ insights, isLoading, isError }: PlantInsightsPanelProps) {
  if (isLoading) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-slate-500">Carregando diagnóstico...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-8 px-4 bg-red-50 rounded-lg border border-red-200">
        <AlertTriangle className="h-5 w-5 text-red-600 mx-auto mb-2" />
        <p className="text-sm text-red-700 font-medium">Erro ao carregar diagnóstico</p>
      </div>
    );
  }

  if (!insights.diagnosis) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-slate-500">Nenhum diagnóstico disponível</p>
      </div>
    );
  }

  const { cuidados, saude, pet, problemasPossiveis } = insights.diagnosis;
  const { reminders = [], maintenance = [] } = insights.cuidadoAgendado;

  return (
    <div className="space-y-5">
      {/* Health & Pet Status */}
      <div className="bg-gradient-to-r from-slate-50 to-white rounded-xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <Heart className="h-4 w-4 text-rose-500" />
          Status da Planta
        </h3>
        <div className="flex gap-2 flex-wrap">
          <div className={`text-xs px-3 py-2 rounded-lg font-medium ${SAUDE_BADGE[saude.status] ?? 'bg-slate-100 text-slate-600'}`}>
            <div className="flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5" />
              <span>Saúde: <strong>{saude.status}</strong></span>
            </div>
          </div>
          <div className={`text-xs px-3 py-2 rounded-lg font-medium ${PET_BADGE[pet.risco] ?? 'bg-slate-100 text-slate-600'}`}>
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>Pet: <strong>{pet.risco}</strong></span>
            </div>
          </div>
        </div>
      </div>

      {/* Care Guide */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <Leaf className="h-4 w-4 text-emerald-600" />
          Guia de Cuidados
        </h3>
        <div className="grid gap-2.5">
          {Object.entries(cuidados).map(([key, value]) => {
            const Icon = CARE_ICONS[key as keyof typeof CARE_ICONS];
            return (
              <div key={key} className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                {Icon && <Icon className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{key}</p>
                  <p className="text-sm text-slate-900 leading-relaxed">{value}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Problems Section */}
      {problemasPossiveis.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Problemas Possíveis
          </h3>
          <div className="space-y-3">
            {problemasPossiveis.map((problema, idx) => (
              <div key={idx} className="border-l-4 border-amber-300 bg-amber-50/50 p-3.5 rounded-r-lg">
                <div className="flex items-start justify-between gap-3 mb-2.5">
                  <h4 className="font-medium text-slate-900">{problema.nome}</h4>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium shrink-0 whitespace-nowrap ${GRAVIDADE_BADGE[problema.gravidade] ?? 'bg-slate-100 text-slate-600'}`}>
                    {problema.gravidade}
                  </span>
                </div>
                <div className="space-y-1.5 ml-0">
                  {problema.planoAcao.map((acao, actionIdx) => (
                    <div key={actionIdx} className="flex items-start gap-2 text-xs text-slate-700">
                      <span className="text-emerald-600 font-bold mt-0.5">✓</span>
                      <span className="leading-relaxed">{acao}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Schedule Section */}
      {(reminders.length > 0 || maintenance.length > 0) && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-600" />
            Cronograma
          </h3>

          {/* Reminders */}
          {reminders.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Lembretes</h4>
              <div className="space-y-2">
                {reminders.map((reminder, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-blue-50/50 rounded-lg border-l-2 border-blue-300">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900">{reminder.titulo}</p>
                      <p className="text-xs text-slate-500">{formatDateBR(reminder.data)}</p>
                    </div>
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium shrink-0 ${STATUS_BADGE[reminder.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      {reminder.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Maintenance */}
          {maintenance.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Manutenção</h4>
              <div className="space-y-2">
                {maintenance.map((maint, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-emerald-50/50 rounded-lg border-l-2 border-emerald-300">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900">{maint.tipo}</p>
                      <p className="text-xs text-slate-500">{formatDateBR(maint.dataRealizada)}</p>
                    </div>
                    <p className="text-xs font-semibold text-emerald-700 shrink-0">{formatCurrencyBR(maint.custo)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
