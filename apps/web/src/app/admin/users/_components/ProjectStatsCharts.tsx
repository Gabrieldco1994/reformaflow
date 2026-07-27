'use client';

import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface ProjectStats {
  byType: { type: string; count: number }[];
  contentTodayByType: { type: string; count: number }[];
  contentTodayTotal: number;
  windowStart: string;
  windowEnd: string;
}

const TYPE_META: Record<string, { label: string; color: string }> = {
  PESSOAL: { label: 'Pessoal', color: '#0A6CF0' },
  REFORMA: { label: 'Reforma', color: '#C2691E' },
  CASA: { label: 'Casa', color: '#1E924A' },
  CARRO: { label: 'Carro', color: '#5E5A52' },
  COMPRA: { label: 'Compra', color: '#7A3FC2' },
  PLANTAS: { label: 'Plantas', color: '#23824D' },
};

function meta(type: string) {
  return TYPE_META[type] ?? { label: type, color: '#6E6A63' };
}

export function ProjectStatsCharts({ stats }: { stats: ProjectStats }) {
  const distribution = (stats.byType ?? []).map((r) => ({ ...r, ...meta(r.type) }));
  const today = (stats.contentTodayByType ?? []).map((r) => ({ ...r, ...meta(r.type) }));
  const totalProjects = distribution.reduce((sum, r) => sum + r.count, 0);
  const contentTotal = stats.contentTodayTotal ?? today.reduce((s, r) => s + r.count, 0);

  return (
    <div className="grid gap-4 mb-4 md:grid-cols-2">
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">Projetos por tipo</h2>
          <span className="text-xs text-gray-500">{totalProjects} ativos</span>
        </div>
        {distribution.length === 0 ? (
          <p className="text-xs text-gray-400 py-10 text-center">Sem projetos.</p>
        ) : (
          <div className="flex items-center gap-4">
            <ResponsiveContainer width="55%" height={200}>
              <PieChart>
                <Pie
                  data={distribution}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={45}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {distribution.map((r) => (
                    <Cell key={r.type} fill={r.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number, _name, item) => [
                    `${value} projeto${value === 1 ? '' : 's'}`,
                    (item?.payload as { label?: string })?.label ?? '',
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
            <ul className="flex-1 space-y-1.5 text-xs">
              {distribution.map((r) => (
                <li key={r.type} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: r.color }}
                  />
                  <span className="text-gray-700">{r.label}</span>
                  <span className="ml-auto font-semibold text-gray-900">{r.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">Criaram conteúdo hoje</h2>
          <span className="text-xs text-gray-500">
            {contentTotal} projeto{contentTotal === 1 ? '' : 's'}
          </span>
        </div>
        {today.length === 0 ? (
          <p className="text-xs text-gray-400 py-10 text-center">
            Nenhum projeto criou conteúdo hoje.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={today} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: '#F3F4F6' }}
                formatter={(value: number) => [
                  `${value} projeto${value === 1 ? '' : 's'}`,
                  'Ativos hoje',
                ]}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {today.map((r) => (
                  <Cell key={r.type} fill={r.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
