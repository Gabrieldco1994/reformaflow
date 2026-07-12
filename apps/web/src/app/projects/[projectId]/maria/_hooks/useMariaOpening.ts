'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';
import type { MonthlyOverviewResponse } from '../../monthly/_types';
import { monthlyOverviewPath } from '../../monthly/_lib/monthly-overview-query';
import {
  buildComprometimentoFuturo,
  deriveMonth,
  mediaMensalPorTipo,
} from '../../monthly/_cockpit/derive';
import { buildMariaStories, type MariaInsight } from '../../monthly/_lib/insights';
import { fmtMoney, mesCurto } from '../../monthly/_cockpit/format';

/**
 * Mensagem de abertura proativa da Maria — reusa EXATAMENTE os mesmos dados e
 * regra pura do "Maria percebeu" do Hoje (`buildMariaStories`, sem chamada de
 * IA nova, sem endpoint novo). A mensagem cita até 2 insights reais.
 */
function describeInsight(insight: MariaInsight): string {
  switch (insight.kind) {
    case 'categoria-alta':
      return `${insight.categoria} está em ${fmtMoney(insight.valorMes)}, acima da média`;
    case 'categoria-economia':
      return `${insight.categoria} está em ${fmtMoney(insight.valorMes)}, abaixo da média — parabéns`;
    case 'parcela-fim': {
      const [, month] = insight.mes.split('-');
      const monthIndex = Number.parseInt(month ?? '1', 10) - 1;
      return `${insight.descricao} libera ${fmtMoney(insight.valorLiberado)} a partir de ${mesCurto(monthIndex)}`;
    }
  }
}

export function useMariaOpening(): { message: string | null; loading: boolean } {
  const { projectId } = useProject();

  const { data, isLoading } = useQuery<MonthlyOverviewResponse>({
    queryKey: ['monthly-overview', projectId, null],
    queryFn: () => api.get(monthlyOverviewPath(projectId, null)),
    enabled: !!projectId,
  });

  const message = useMemo(() => {
    if (!data) return null;
    const monthKey = data.mesAtual;
    const month = deriveMonth(data, monthKey);
    const mediaMap = mediaMensalPorTipo(
      data.entries ?? data.mesAtualEntries,
      Number.parseInt(monthKey.slice(0, 4), 10),
    );
    const comprometimento = buildComprometimentoFuturo(data, monthKey, 12, projectId);
    const insights = buildMariaStories({
      categorias: month.categorias,
      mediaMensalPorTipo: mediaMap,
      comprometimento,
    }).slice(0, 2);

    if (insights.length === 0) {
      return 'Bom dia 👋 Nada fora do padrão no seu radar este mês — pergunte o que quiser.';
    }

    const bullets = insights.map((i) => describeInsight(i)).join('; e ');
    return `Bom dia 👋 Do seu radar: ${bullets}. Fora isso, o mês segue no plano.`;
  }, [data, projectId]);

  return { message, loading: isLoading };
}
