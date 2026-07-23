'use client';

import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip } from 'recharts';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

interface PricePoint {
  id: string;
  priceCents: number;
  store: string | null;
  link: string | null;
  checkedAt: string;
}

interface PriceHistoryChartProps {
  projectId: string;
  itemId: string;
}

/**
 * Sparkline do histórico de preço do item (issue a, mockup M4). 1 ponto
 * por checagem com preço encontrado (scheduler horário, "atualizar" ou
 * "atualizar todos"). Sem dado fabricado: com menos de 2 pontos ainda não
 * há linha para desenhar, então mostramos um aviso em vez de inventar.
 */
export function PriceHistoryChart({ projectId, itemId }: PriceHistoryChartProps) {
  const { data: points = [], isLoading } = useQuery<PricePoint[]>({
    queryKey: ['price-monitor-history', projectId, itemId],
    queryFn: () => api.get(`/projects/${projectId}/price-monitor/items/${itemId}/history`),
  });

  if (isLoading) {
    return <p className="text-xs text-darc-velvet/50">Carregando histórico...</p>;
  }

  if (points.length < 2) {
    return (
      <p className="text-xs text-darc-velvet/50">
        Histórico aparece após a 2ª checagem de preço.
      </p>
    );
  }

  const chartData = points.map((point) => ({
    checkedAt: point.checkedAt,
    priceCents: point.priceCents,
  }));

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-darc-velvet/70">
        Histórico de preço ({points.length} checagens)
      </p>
      <ResponsiveContainer width="100%" height={64}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <YAxis domain={['dataMin', 'dataMax']} hide />
          <Tooltip
            formatter={(value: number) => formatCurrency(value / 100)}
            labelFormatter={(label: string) => new Date(label).toLocaleDateString('pt-BR')}
          />
          <Line
            type="monotone"
            dataKey="priceCents"
            stroke="#1C1C1E"
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
