'use client';

import { formatDateBR } from '@/lib/utils';
import { CheckCircle } from 'lucide-react';
import type { PlantInsightsResponse } from '../_types';

interface PlantInsightsPanelProps {
  insights: PlantInsightsResponse;
  isLoading?: boolean;
  isError?: boolean;
}

// Badge color mapping constants
const SAUDE_BADGE: Record<string, string> = {
  SAUDAVEL: 'bg-green-100 text-green-800',
  ATENCAO: 'bg-amber-100 text-amber-800',
  CRITICA: 'bg-red-100 text-red-800',
};

const PET_BADGE: Record<string, string> = {
  SEGURO: 'bg-green-100 text-green-800',
  CAUTELA: 'bg-amber-100 text-amber-800',
  TOXICA: 'bg-red-100 text-red-800',
  DESCONHECIDO: 'bg-gray-100 text-gray-600',
};

const GRAVIDADE_BADGE: Record<string, string> = {
  LEVE: 'bg-blue-100 text-blue-800',
  MEDIA: 'bg-amber-100 text-amber-800',
  GRAVE: 'bg-red-100 text-red-800',
};

const STATUS_BADGE: Record<string, string> = {
  PENDENTE: 'bg-gray-100 text-gray-800',
  CONCLUIDO: 'bg-green-100 text-green-800',
  CANCELADO: 'bg-red-100 text-red-800',
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
      <div className="text-center py-4">
        <p className="text-sm text-gray-500">Carregando diagnóstico...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-4">
        <p className="text-sm text-red-600">Erro ao carregar diagnóstico</p>
      </div>
    );
  }

  if (!insights.diagnosis) {
    return (
      <div className="text-center py-4">
        <p className="text-sm text-gray-500">Nenhum diagnóstico disponível</p>
      </div>
    );
  }

  const { cuidados, saude, pet, problemasPossiveis } = insights.diagnosis;
  const { reminders = [], maintenance = [] } = insights.cuidadoAgendado;

  return (
    <div className="space-y-4">
      {/* Care Guide Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Guia de Cuidados</h3>
        <div className="space-y-2">
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-600">Rega</span>
            <span className="font-medium text-gray-900">{cuidados.rega}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-600">Luz</span>
            <span className="font-medium text-gray-900">{cuidados.luz}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-600">Poda</span>
            <span className="font-medium text-gray-900">{cuidados.poda}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-600">Adubação</span>
            <span className="font-medium text-gray-900">{cuidados.adubacao}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-600">Solo</span>
            <span className="font-medium text-gray-900">{cuidados.solo}</span>
          </div>
        </div>
      </div>

      {/* Health & Pet Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-900 mb-3">Status</h3>
        <div className="flex flex-wrap gap-2">
          <span className={`text-xs px-2.5 py-1.5 rounded-full font-medium ${SAUDE_BADGE[saude.status] ?? 'bg-gray-100 text-gray-600'}`}>
            Saúde: {saude.status}
          </span>
          <span className={`text-xs px-2.5 py-1.5 rounded-full font-medium ${PET_BADGE[pet.risco] ?? 'bg-gray-100 text-gray-600'}`}>
            Risco Pet: {pet.risco}
          </span>
        </div>
      </div>

      {/* Problems Section */}
      {problemasPossiveis.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Problemas Possíveis</h3>
          <div className="space-y-3">
            {problemasPossiveis.map((problema, idx) => (
              <div key={idx} className="border-l-4 border-orange-300 pl-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-medium text-gray-900">{problema.nome}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${GRAVIDADE_BADGE[problema.gravidade] ?? 'bg-gray-100 text-gray-600'}`}>
                    {problema.gravidade}
                  </span>
                </div>
                <div className="space-y-1">
                  {problema.planoAcao.map((acao, actionIdx) => (
                    <div key={actionIdx} className="flex items-center gap-2 text-sm text-gray-700">
                      <CheckCircle className="h-3.5 w-3.5 text-green-600 shrink-0" />
                      {acao}
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
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Cronograma</h3>
          <div className="space-y-4">
            {/* Reminders Subsection */}
            {reminders.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Lembretes</h4>
                <div className="space-y-1.5">
                  {reminders.map((reminder, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm">
                      <div>
                        <p className="font-medium text-gray-900">{reminder.titulo}</p>
                        <p className="text-xs text-gray-500">{formatDateBR(reminder.data)}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[reminder.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {reminder.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Maintenance Subsection */}
            {maintenance.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Manutenção</h4>
                <div className="space-y-1.5">
                  {maintenance.map((maint, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm">
                      <div>
                        <p className="font-medium text-gray-900">{maint.tipo}</p>
                        <p className="text-xs text-gray-500">{formatDateBR(maint.dataRealizada)}</p>
                      </div>
                      <span className="text-xs text-gray-700 font-medium">{formatCurrencyBR(maint.custo)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
