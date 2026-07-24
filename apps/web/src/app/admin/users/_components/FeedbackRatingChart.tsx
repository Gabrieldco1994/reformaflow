'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const COLORS = ['#DC2626', '#F97316', '#EAB308', '#84CC16', '#1E924A']; // 1★..5★, ruim -> bom

export interface FeedbackRatingRow {
  rating?: number | null;
}

/**
 * Distribuição das notas 1-5 do passo "quão fácil foi usar o app" no final
 * do onboarding. Calculada no client a partir da lista de feedbacks já
 * carregada pela página — sem endpoint novo.
 */
export function FeedbackRatingChart({ feedbacks }: { feedbacks: FeedbackRatingRow[] }) {
  const rated = feedbacks.filter(
    (f): f is { rating: number } => typeof f.rating === 'number' && f.rating >= 1 && f.rating <= 5,
  );
  const data = [1, 2, 3, 4, 5].map((n) => ({
    stars: `${n}★`,
    count: rated.filter((f) => f.rating === n).length,
  }));
  const total = rated.length;
  const avg = total ? (rated.reduce((s, f) => s + f.rating, 0) / total).toFixed(1) : null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-900">Facilidade de uso (onboarding)</h2>
        {avg && (
          <span className="text-xs text-gray-500">
            média {avg} · {total} avaliaç{total === 1 ? 'ão' : 'ões'}
          </span>
        )}
      </div>
      {total === 0 ? (
        <p className="text-xs text-gray-400 py-10 text-center">Sem avaliações ainda.</p>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <XAxis dataKey="stars" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: '#F3F4F6' }}
              formatter={(value: number) => [`${value} avaliação${value === 1 ? '' : 'ões'}`, '']}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => (
                <Cell key={d.stars} fill={COLORS[i]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
