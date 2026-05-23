'use client';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';

interface ChartTooltipProps {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}

function ChartTooltipCurrency({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-darc-linen rounded-lg shadow-darc-soft p-3 text-xs">
      <p className="font-medium text-darc-velvet mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {formatCurrency(p.value / 100)}
        </p>
      ))}
    </div>
  );
}

interface DespesasData {
  mesLabel: string;
  planejado: number;
  pago: number;
}
interface SaldoData {
  mesLabel: string;
  recebimentos: number;
  despesas: number;
  recebimentosRealizados?: number;
  despesasRealizadas?: number;
  saldoAcumulado: number;
  saldoAcumuladoRealizado?: number;
}

interface Props {
  despesasChartData: DespesasData[];
  saldoChartData: SaldoData[];
}

export default function DashboardCharts({ despesasChartData, saldoChartData }: Props) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
      {despesasChartData.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-4">
            Despesas Mensais (Planejado × Pago)
          </h2>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={despesasChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EDDBC2" />
              <XAxis dataKey="mesLabel" tick={{ fontSize: 12, fill: '#391212' }} />
              <YAxis
                tickFormatter={(v: number) => formatCurrency(v / 100)}
                tick={{ fontSize: 11, fill: '#391212' }}
                width={90}
              />
              <Tooltip content={<ChartTooltipCurrency />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="planejado" name="Planejado" fill="#F27D33" radius={[6, 6, 0, 0]} />
              <Bar dataKey="pago" name="Pago" fill="#900131" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      {saldoChartData.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-1">
            Saldo Acumulado do Fluxo de Caixa
          </h2>
          <p className="text-[11px] text-darc-velvet/60 mb-3">
            <span className="font-semibold">Projetado</span> inclui planejados/previstos; <span className="font-semibold">Realizado</span> considera apenas pagos e em caixa.
          </p>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={saldoChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EDDBC2" />
              <XAxis dataKey="mesLabel" tick={{ fontSize: 12, fill: '#391212' }} />
              <YAxis
                tickFormatter={(v: number) => formatCurrency(v / 100)}
                tick={{ fontSize: 11, fill: '#391212' }}
                width={90}
              />
              <Tooltip content={<ChartTooltipCurrency />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="recebimentos"
                name="Recebimentos"
                stroke="#BFA4D1"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="despesas"
                name="Despesas"
                stroke="#EB1C24"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="saldoAcumulado"
                name="Saldo Projetado"
                stroke="#4F000B"
                strokeWidth={3}
                strokeDasharray="6 4"
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="saldoAcumuladoRealizado"
                name="Saldo Realizado"
                stroke="#138A6B"
                strokeWidth={3}
                dot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </section>
      )}
    </div>
  );
}
