"use client";

import { useProject } from "@/contexts/project-context";
import { useAuth } from "@/contexts/auth-context";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Check } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, formatDateBR } from "@/lib/utils";
import type { DashboardResponse } from "@/types";
import type { ProjectType } from "@reformaflow/domain";
import { hasFeature } from "@reformaflow/domain";
import ManagementDashboard from "./_components/ManagementDashboard";
import { resolveDashboardVariant } from "./_lib/resolve-variant";
import { KpiTile } from "@/components/KpiTile";
import { moneyGlance } from "@/lib/money";

const DashboardCharts = dynamic(() => import("./_components/DashboardCharts"), {
  ssr: false,
  loading: () => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 h-[340px] animate-pulse" />
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 h-[340px] animate-pulse" />
    </div>
  ),
});

function formatMesLabel(mes: string) {
  const [y, m] = mes.split("-");
  const meses = [
    "Jan",
    "Fev",
    "Mar",
    "Abr",
    "Mai",
    "Jun",
    "Jul",
    "Ago",
    "Set",
    "Out",
    "Nov",
    "Dez",
  ];
  return `${meses[parseInt(m) - 1]}/${y.slice(2)}`;
}

// ─── Skeleton para reservar layout (evita CLS) ──────────────

function FinancialDashboardSkeleton() {
  return (
    <div className="space-y-6 md:space-y-8 animate-pulse">
      {/* KPIs mobile */}
      <div className="md:hidden -mx-4 px-4 overflow-x-hidden">
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-[78%] h-[88px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
          <div className="flex-shrink-0 w-[78%] h-[88px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        </div>
      </div>
      {/* KPIs desktop (6 cards) */}
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-[96px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen"
          />
        ))}
      </div>
      {/* Charts (2x 340px) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
        <div className="h-[340px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
        <div className="h-[340px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
      </div>
      {/* Resumo section */}
      <div className="h-[200px] rounded-2xl bg-white shadow-darc-soft border border-darc-linen" />
    </div>
  );
}

// ─── Financial Dashboard (REFORMA / COMPRA) ──────────────────

function FinancialDashboard({
  projectId,
  projectType,
}: {
  projectId: string;
  projectType: string;
}) {
  const { data, isLoading, error } = useQuery<DashboardResponse>({
    queryKey: ["dashboard", projectId],
    queryFn: () => api.get(`/projects/${projectId}/dashboard`),
  });

  const despesasChartData = useMemo(
    () =>
      (data?.despesasMensal ?? []).map((d) => ({
        ...d,
        mesLabel: formatMesLabel(d.mes),
      })),
    [data?.despesasMensal],
  );

  const saldoChartData = useMemo(
    () =>
      (data?.saldoAcumuladoMensal ?? []).map((d) => ({
        ...d,
        mesLabel: formatMesLabel(d.mes),
      })),
    [data?.saldoAcumuladoMensal],
  );

  if (isLoading) return <FinancialDashboardSkeleton />;
  if (error)
    return <div className="text-darc-red">Erro ao carregar dashboard.</div>;
  if (!data) return null;

  const kpis: { label: string; value: number; tone: 'positive' | 'negative' | 'neutral' }[] = [
    {
      label: "Dinheiro Disponível",
      value: data.kpis.dinheiroDisponivel,
      tone: "neutral",
    },
    { label: "Já Paguei", value: data.kpis.jaPaguei, tone: "neutral" },
    {
      label: "Previsão de Gastos",
      value: data.kpis.previsaoGastos,
      tone: "negative",
    },
    {
      label: "Previsão de Recebimentos",
      value: data.kpis.previsaoRecebimentos,
      tone: "positive",
    },
    {
      label: "Previsão de Saldo",
      value: data.kpis.previsaoSaldo,
      tone: data.kpis.previsaoSaldo >= 0 ? "positive" : "negative",
    },
    {
      label: "Saldo",
      value: data.kpis.saldo,
      tone: data.kpis.saldo >= 0 ? "positive" : "negative",
    },
  ];

  const showRooms = hasFeature(projectType as ProjectType, "rooms");

  return (
    <div className="space-y-6 md:space-y-8">
      {projectType === "PESSOAL" && (
        <Link
          href={`/projects/${projectId}/monthly`}
          className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-gradient-to-br from-indigo-50 to-rose-50 border border-indigo-100 hover:border-indigo-300 transition-colors group"
        >
          <div className="flex items-center gap-3">
            <CalendarClock className="w-5 h-5 text-indigo-700 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-darc-velvet">
                Visão Mensal Consolidada
              </p>
              <p className="text-[11px] text-darc-velvet/70 leading-snug">
                Gasto, recebido e saldo do mês — agrega Reforma, Casa e Carro
              </p>
            </div>
          </div>
          <span className="text-xs text-indigo-700 group-hover:translate-x-0.5 transition-transform">
            Ver →
          </span>
        </Link>
      )}

      {/* KPIs — grid responsivo com KpiTile canônico */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {kpis.map((kpi) => (
          <div key={kpi.label} role="article" aria-label={kpi.label} className="min-w-0">
            <KpiTile
              variant="support"
              layer="glance"
              tone={kpi.tone}
              label={kpi.label}
              value={moneyGlance(kpi.value)}
            />
          </div>
        ))}
      </div>

      <DashboardCharts
        despesasChartData={despesasChartData}
        saldoChartData={saldoChartData}
      />

      {showRooms &&
        data.resumoPorAmbiente &&
        data.resumoPorAmbiente.length > 0 && (
          <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
            <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">
              Resumo por Ambiente
            </h2>
            {/* Desktop: tabela */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-darc-linen">
                    <th className="text-left px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">
                      Ambiente
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">
                      Planejado
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-darc-velvet/60 uppercase text-[10px] tracking-[0.18em]">
                      Pago
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-darc-linen">
                  {data.resumoPorAmbiente.map((room) => (
                    <tr key={room.roomName} className="hover:bg-darc-linen/40">
                      <td className="px-3 py-3 text-darc-velvet">
                        {room.roomName}
                      </td>
                      <td className="px-3 py-3 text-right text-darc-velvet">
                        {formatCurrency(room.planned / 100)}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-darc-raspberry">
                        {formatCurrency(room.actual / 100)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile: lista */}
            <div className="md:hidden space-y-2">
              {data.resumoPorAmbiente.map((room) => (
                <div
                  key={room.roomName}
                  className="flex items-center justify-between py-2 border-b border-darc-linen last:border-0"
                >
                  <span className="text-sm font-medium text-darc-velvet">
                    {room.roomName}
                  </span>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-[0.15em] text-darc-velvet/50">
                      {formatCurrency(room.planned / 100)} planejado
                    </p>
                    <p className="text-sm font-bold text-darc-raspberry">
                      {formatCurrency(room.actual / 100)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

      {data.resumoPorTipoDespesa && data.resumoPorTipoDespesa.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">
            Resumo por Tipo de Despesa
          </h2>
          <div className="divide-y divide-darc-linen">
            {data.resumoPorTipoDespesa.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between py-2.5"
              >
                <span className="text-sm text-darc-velvet">{item.label}</span>
                <span className="text-sm font-semibold text-darc-velvet">
                  {formatCurrency(item.total / 100)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.resumoPorCategoria && data.resumoPorCategoria.length > 0 && (
        <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
          <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">
            Resumo por Categoria
          </h2>
          <div className="divide-y divide-darc-linen">
            {data.resumoPorCategoria.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between py-2.5"
              >
                <span className="text-sm text-darc-velvet">{item.label}</span>
                <span className="text-sm font-semibold text-darc-velvet">
                  {formatCurrency(item.total / 100)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface PlantMaintenance {
  id: string;
  tipo: string;
  dataProxima?: string;
  fornecedor?: string;
  plantId?: string | null;
}

interface PlantReminder {
  id: string;
  titulo: string;
  descricao?: string;
  data: string;
  status: string;
  plantId?: string | null;
}

interface PlantTask {
  id: string;
  titulo: string;
  descricao?: string;
  data: string;
  plantId?: string | null;
}

interface PlantSummary {
  id: string;
  nome: string;
  ultimaSaude?: string | null;
}

function dayGroupLabel(date: Date, today: Date) {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round(
    (startOfDay(date).getTime() - startOfDay(today).getTime()) /
      (1000 * 60 * 60 * 24),
  );
  if (diffDays < 0) return "Atrasadas";
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Amanhã";
  const weekday = date.toLocaleDateString("pt-BR", { weekday: "long" });
  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

function PlantDashboard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [completingKeys, setCompletingKeys] = useState<Set<string>>(new Set());
  const { data: maintenance } = useQuery<PlantMaintenance[]>({
    queryKey: ["maintenance-logs", projectId],
    queryFn: () => api.get(`/projects/${projectId}/maintenance-logs`),
  });
  const { data: reminders } = useQuery<PlantReminder[]>({
    queryKey: ["reminders", projectId],
    queryFn: () => api.get(`/projects/${projectId}/reminders`),
  });
  const { data: plants } = useQuery<PlantSummary[]>({
    queryKey: ["plants", projectId],
    queryFn: () => api.get(`/projects/${projectId}/plants`),
  });
  const plantNameById = useMemo(
    () => new Map((plants ?? []).map((p) => [p.id, p.nome])),
    [plants],
  );

  const today = new Date();
  const in7Days = new Date(today);
  in7Days.setDate(today.getDate() + 7);

  // Cronograma semanal: só reminders (regar/checar/tratar). Manutenções viram
  // seção própria abaixo — mesmo padrão de CASA/CARRO (Próximas Manutenções
  // separado de Lembretes), evita misturar "o que fazer" com "o que já foi feito".
  const tasks = useMemo<PlantTask[]>(() => {
    return (reminders ?? [])
      .filter((r) => r.status === "PENDENTE")
      .map((r) => ({
        id: r.id,
        titulo: r.titulo,
        descricao: r.descricao,
        data: r.data,
        plantId: r.plantId,
      }))
      .filter((t) => new Date(t.data) <= in7Days)
      .sort((a, b) => new Date(a.data).getTime() - new Date(b.data).getTime());
  }, [reminders, in7Days]);

  const upcomingMaintenance = useMemo(() => {
    return (maintenance ?? [])
      .filter((m) => m.dataProxima && new Date(m.dataProxima) >= today)
      .sort(
        (a, b) => new Date(a.dataProxima!).getTime() - new Date(b.dataProxima!).getTime(),
      )
      .slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maintenance]);

  const totalPlantas = plants?.length ?? 0;
  const plantasDoentes = (plants ?? []).filter(
    (p) => p.ultimaSaude === "ATENCAO" || p.ultimaSaude === "CRITICA",
  ).length;
  // ponytail: detecta "regar" pelo prefixo do título gerado em plants-schedule.ts
  // ("Regar {planta}") em vez de um campo `tipo` dedicado no Reminder — upgrade
  // pra um campo estruturado se outros tipos de tarefa precisarem da mesma lógica.
  const plantasParaRegar = new Set(
    (reminders ?? [])
      .filter(
        (r) =>
          r.status === "PENDENTE" &&
          r.titulo.startsWith("Regar ") &&
          new Date(r.data) <= in7Days &&
          r.plantId,
      )
      .map((r) => r.plantId),
  ).size;

  // Agrupa por dia (Atrasadas / Hoje / Amanhã / dia da semana) preservando a ordem cronológica.
  const groupedTasks = useMemo(() => {
    const groups = new Map<string, PlantTask[]>();
    for (const task of tasks) {
      const label = dayGroupLabel(new Date(task.data), today);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(task);
    }
    return Array.from(groups.entries());
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  async function completeTask(task: PlantTask) {
    setCompletingKeys((prev) => new Set(prev).add(task.id));
    try {
      await api.patch(`/projects/${projectId}/reminders/${task.id}`, {
        status: "CONCLUIDO",
      });
      await queryClient.invalidateQueries({ queryKey: ["reminders", projectId] });
    } finally {
      setCompletingKeys((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5">
          <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60">
            Total de Plantas
          </p>
          <p className="text-2xl font-bold text-darc-velvet mt-2">
            {totalPlantas}
          </p>
        </div>
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5">
          <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60">
            Plantas Doentes
          </p>
          <p className={`text-2xl font-bold mt-2 ${plantasDoentes > 0 ? "text-darc-red" : "text-darc-velvet"}`}>
            {plantasDoentes}
          </p>
        </div>
        <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-5">
          <p className="text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60">
            Falta Regar na Semana
          </p>
          <p className="text-2xl font-bold text-darc-velvet mt-2">
            {plantasParaRegar}
          </p>
        </div>
      </div>

      <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">
          📅 Cronograma semanal
        </h2>
        {tasks.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">
            Sem tarefas para os próximos 7 dias.
          </p>
        ) : (
          <div className="space-y-5">
            {groupedTasks.map(([label, groupTasks]) => (
              <div key={label}>
                <h3
                  className={`text-xs font-semibold tracking-[0.14em] uppercase mb-2 ${
                    label === "Atrasadas"
                      ? "text-darc-red"
                      : "text-darc-velvet/60"
                  }`}
                >
                  {label}
                </h3>
                <div className="space-y-2">
                  {groupTasks.map((task) => {
                    const due = new Date(task.data);
                    const isOverdue = due < today;
                    const key = task.id;
                    const isCompleting = completingKeys.has(key);
                    return (
                      <div
                        key={key}
                        className={`rounded-xl border p-3 flex items-start gap-3 ${isOverdue ? "border-darc-red bg-darc-red-bright/5" : "border-darc-linen bg-darc-linen/40"}`}
                      >
                        <button
                          onClick={() => completeTask(task)}
                          disabled={isCompleting}
                          title="Marcar como feita"
                          className={`group mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
                            isCompleting
                              ? "border-darc-velvet/30 bg-darc-velvet/10"
                              : "border-darc-velvet/30 hover:border-darc-red hover:bg-darc-red-bright/10"
                          }`}
                        >
                          <Check
                            className={`h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity ${
                              isCompleting
                                ? "text-darc-velvet/40 opacity-100"
                                : "text-darc-red"
                            }`}
                          />
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium text-darc-velvet">
                              {task.titulo}
                              {(plants?.length ?? 0) > 1 &&
                                task.plantId &&
                                plantNameById.has(task.plantId) && (
                                  <span className="ml-2 text-xs font-normal text-darc-velvet/60">
                                    🪴 {plantNameById.get(task.plantId)}
                                  </span>
                                )}
                            </p>
                            <span className="text-xs text-darc-velvet/70 whitespace-nowrap">
                              {formatDateBR(task.data)}
                            </span>
                          </div>
                          {task.descricao && (
                            <p className="text-sm text-darc-velvet/70 mt-1">
                              {task.descricao}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-3">
          🔧 Próximas Manutenções
        </h2>
        {upcomingMaintenance.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">Nenhuma manutenção agendada.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {upcomingMaintenance.map((m) => {
              const daysUntil = Math.ceil(
                (new Date(m.dataProxima!).getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
              );
              const accent = daysUntil <= 7 ? "bg-darc-red-bright" : daysUntil <= 30 ? "bg-darc-sunfire" : "bg-darc-mist";
              return (
                <div key={m.id} className="rounded-xl bg-darc-linen/40 p-3 relative overflow-hidden">
                  <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-r-full ${accent}`} />
                  <p className="font-semibold text-darc-velvet pl-2">
                    {m.tipo}
                    {(plants?.length ?? 0) > 1 && m.plantId && plantNameById.has(m.plantId) && (
                      <span className="ml-2 text-xs font-normal text-darc-velvet/60">
                        🪴 {plantNameById.get(m.plantId)}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-darc-velvet/70 mt-1 pl-2">Próxima: {formatDateBR(m.dataProxima!)}</p>
                  <p className="text-xs text-darc-velvet/60 pl-2">{daysUntil <= 0 ? "⚠ Atrasada!" : `Em ${daysUntil} dias`}</p>
                  {m.fornecedor && <p className="text-xs text-darc-velvet/50 mt-1 pl-2">📞 {m.fornecedor}</p>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { projectId, projectType, projectName } = useProject();
  const { hasModule } = useAuth();

  const variant = resolveDashboardVariant(projectType as ProjectType);

  // PESSOAL usa o Cockpit (rota /monthly) como visão principal — redireciona.
  useEffect(() => {
    if (projectType === "PESSOAL") {
      router.replace(`/projects/${projectId}/monthly`);
    }
  }, [projectType, projectId, router]);

  if (projectType === "PESSOAL") return null;

  const isFinancial = variant === "financial";
  const isManagement = variant === "management";
  const isPlants = variant === "plants";

  return (
    <div className="space-y-6 md:space-y-8">
      {hasModule("financialDashboard") && (
        <Link
          href="/financeiro"
          className="hidden md:inline-flex items-center gap-1.5 text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 hover:text-darc-red transition-colors"
        >
          ← Visão Geral
        </Link>
      )}
      <header className="hidden md:block -mt-4">
        <p className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60">
          Visão geral do projeto
        </p>
        <h1 className="font-editorial italic text-3xl text-darc-velvet">
          {projectName}
        </h1>
      </header>
      <header className="md:hidden -mt-2">
        {hasModule("financialDashboard") && (
          <Link
            href="/financeiro"
            className="text-[10px] tracking-[0.18em] uppercase text-darc-velvet/60 hover:text-darc-red"
          >
            ← Visão Geral
          </Link>
        )}
        <h1 className="font-editorial italic text-2xl text-darc-velvet leading-tight mt-1">
          {projectName}
        </h1>
      </header>
      {isFinancial && (
        <FinancialDashboard projectId={projectId} projectType={projectType} />
      )}
      {isManagement && (
        <ManagementDashboard projectId={projectId} projectType={projectType} />
      )}
      {isPlants && <PlantDashboard projectId={projectId} />}
    </div>
  );
}
