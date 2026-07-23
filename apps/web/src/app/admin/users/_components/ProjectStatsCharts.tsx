'use client';

import { useState } from 'react';
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

export interface TypeUser {
  userId: string | null;
  name: string;
  count: number;
}

export interface TypeBreakdown {
  type: string;
  count: number;
  users?: TypeUser[];
}

export interface ProjectStats {
  byType: TypeBreakdown[];
  contentTodayByType: TypeBreakdown[];
  contentTodayTotal: number;
  expensesByType: TypeBreakdown[];
  expensesTotal: number;
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

function UsersPanel({
  rows,
  selectedType,
  onClear,
  unit = 'projeto',
}: {
  rows: TypeBreakdown[];
  selectedType: string | null;
  onClear: () => void;
  unit?: string;
}) {
  if (!selectedType) {
    return (
      <p className="mt-3 text-[11px] text-gray-400 border-t border-gray-100 pt-2">
        Clique num tipo para ver quais usuários.
      </p>
    );
  }
  const row = rows.find((r) => r.type === selectedType);
  const users = row?.users ?? [];
  const m = meta(selectedType);
  return (
    <div className="mt-3 border-t border-gray-100 pt-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: m.color }} />
          {m.label}
        </span>
        <button onClick={onClear} className="text-[11px] text-brand-600 hover:underline">
          Limpar
        </button>
      </div>
      {users.length === 0 ? (
        <p className="text-[11px] text-gray-400">Sem detalhamento por usuário.</p>
      ) : (
        <ul className="space-y-1 text-xs max-h-40 overflow-y-auto">
          {users.map((u) => (
            <li key={u.userId ?? '__none__'} className="flex items-center gap-2">
              <span className={`truncate ${u.userId ? 'text-gray-700' : 'text-gray-400 italic'}`}>
                {u.name}
              </span>
              <span className="ml-auto font-semibold text-gray-900">
                {u.count} {unit}{u.count === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TypeBarCard({
  title,
  total,
  unit,
  tooltipLabel,
  byType,
  emptyText,
}: {
  title: string;
  total: number;
  unit: string;
  tooltipLabel: string;
  byType: TypeBreakdown[];
  emptyText: string;
}) {
  const data = byType.map((r) => ({ ...r, ...meta(r.type) }));
  const [selected, setSelected] = useState<string | null>(null);
  const plural = (n: number) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <span className="text-xs text-gray-500">{plural(total)}</span>
      </div>
      {data.length === 0 ? (
        <p className="text-xs text-gray-400 py-10 text-center">{emptyText}</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: '#F3F4F6' }}
                formatter={(value: number) => [plural(value), tooltipLabel]}
              />
              <Bar
                dataKey="count"
                radius={[4, 4, 0, 0]}
                onClick={(d: { type?: string }) =>
                  d?.type && setSelected((cur) => (cur === d.type ? null : d.type!))
                }
                className="cursor-pointer"
              >
                {data.map((r) => (
                  <Cell
                    key={r.type}
                    fill={r.color}
                    opacity={selected && selected !== r.type ? 0.35 : 1}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <UsersPanel rows={byType} selectedType={selected} onClear={() => setSelected(null)} unit={unit} />
        </>
      )}
    </div>
  );
}

export function ProjectStatsCharts({ stats }: { stats: ProjectStats }) {
  const byType = stats.byType ?? [];
  const contentByType = stats.contentTodayByType ?? [];
  const expensesByType = stats.expensesByType ?? [];
  const distribution = byType.map((r) => ({ ...r, ...meta(r.type) }));
  const totalProjects = distribution.reduce((sum, r) => sum + r.count, 0);
  const contentTotal = stats.contentTodayTotal ?? contentByType.reduce((s, r) => s + r.count, 0);
  const expensesTotal = stats.expensesTotal ?? expensesByType.reduce((s, r) => s + r.count, 0);

  const [selectedDist, setSelectedDist] = useState<string | null>(null);
  const toggle =
    (setter: React.Dispatch<React.SetStateAction<string | null>>) => (type: string) =>
      setter((cur) => (cur === type ? null : type));

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
          <>
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
                    onClick={(d: { type?: string }) => d?.type && toggle(setSelectedDist)(d.type)}
                    className="cursor-pointer"
                  >
                    {distribution.map((r) => (
                      <Cell
                        key={r.type}
                        fill={r.color}
                        opacity={selectedDist && selectedDist !== r.type ? 0.35 : 1}
                      />
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
                  <li key={r.type}>
                    <button
                      onClick={() => toggle(setSelectedDist)(r.type)}
                      className={`flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-gray-50 ${
                        selectedDist === r.type ? 'bg-gray-100' : ''
                      }`}
                    >
                      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: r.color }} />
                      <span className="text-gray-700">{r.label}</span>
                      <span className="ml-auto font-semibold text-gray-900">{r.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <UsersPanel rows={byType} selectedType={selectedDist} onClear={() => setSelectedDist(null)} />
          </>
        )}
      </div>

      <TypeBarCard
        title="Criaram conteúdo hoje"
        total={contentTotal}
        unit="projeto"
        tooltipLabel="Ativos hoje"
        byType={contentByType}
        emptyText="Nenhum projeto criou conteúdo hoje."
      />

      <TypeBarCard
        title="Despesas por tipo"
        total={expensesTotal}
        unit="despesa"
        tooltipLabel="Total de despesas"
        byType={expensesByType}
        emptyText="Sem despesas."
      />
    </div>
  );
}
