"use client";

import { useEffect, useState } from "react";
import { useProject } from "@/contexts/project-context";
import { api } from "@/lib/api";
import { formatDateBR } from "@/lib/utils";
import {
  Sprout,
  Trash2,
  Pencil,
  X,
  Check,
  Droplets,
  HeartPulse,
  Plus,
} from "lucide-react";
import { CreatePlantModal } from "./_components/CreatePlantModal";
import { PlantInsightsPanel } from "./_components/PlantInsightsPanel";
import { usePlantInsights } from "./_hooks/usePlantInsights";

interface Plant {
  id: string;
  nome: string;
  localizacao: string | null;
  fotoUrl: string | null;
  especiePopular: string | null;
  especieCientifica: string | null;
  ultimaSaude: string | null;
  ultimoRiscoPet: string | null;
  ultimoDiagnosticoEm: string | null;
  observacoes: string | null;
}

interface DiagnosisHistoryEntry {
  id: string;
  createdAt: string;
  especiePopular: string | null;
  especieCientifica: string | null;
  saudeStatus: string | null;
  riscoPet: string | null;
}

interface Reminder {
  id: string;
  titulo: string;
  data: string;
  status: string;
  plantId: string | null;
}

const SAUDE_BADGE: Record<string, string> = {
  SAUDAVEL: "bg-green-100 text-green-800",
  ATENCAO: "bg-amber-100 text-amber-800",
  CRITICA: "bg-red-100 text-red-800",
};

const PET_BADGE: Record<string, string> = {
  SEGURO: "bg-green-100 text-green-800",
  CAUTELA: "bg-amber-100 text-amber-800",
  TOXICA: "bg-red-100 text-red-800",
  DESCONHECIDO: "bg-gray-100 text-gray-600",
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface PlantProfileFormProps {
  plantId: string;
  form: { nome: string; localizacao: string; observacoes: string };
  onChange: (form: {
    nome: string;
    localizacao: string;
    observacoes: string;
  }) => void;
  onSave: () => void;
  onCancel: () => void;
}

function PlantProfileForm({
  plantId,
  form,
  onChange,
  onSave,
  onCancel,
}: PlantProfileFormProps) {
  const { projectId } = useProject();
  const { data, loading, error } = usePlantInsights(projectId, plantId);
  const fieldClass =
    "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600 focus-visible:ring-offset-2";
  return (
    <div className="space-y-5 border-l-2 border-green-200 pl-4 sm:pl-6">
      <section aria-labelledby={`plant-data-${plantId}`} className="space-y-3">
        <div>
          <h2
            id={`plant-data-${plantId}`}
            className="font-semibold text-gray-900"
          >
            Dados da planta
          </h2>
          <p className="text-xs text-gray-500">
            Informações que você pode atualizar.
          </p>
        </div>
        <label className="block text-sm font-medium text-gray-700">
          Nome
          <input
            value={form.nome}
            onChange={(e) => onChange({ ...form, nome: e.target.value })}
            className={`mt-1 ${fieldClass}`}
          />
        </label>
        <label className="block text-sm font-medium text-gray-700">
          Localização
          <input
            value={form.localizacao}
            onChange={(e) => onChange({ ...form, localizacao: e.target.value })}
            placeholder="Ex: sala, varanda"
            className={`mt-1 ${fieldClass}`}
          />
        </label>
        <label className="block text-sm font-medium text-gray-700">
          Observações
          <textarea
            value={form.observacoes}
            onChange={(e) => onChange({ ...form, observacoes: e.target.value })}
            className={`mt-1 ${fieldClass}`}
            rows={2}
          />
        </label>
      </section>
      <section
        aria-labelledby={`plant-insights-${plantId}`}
        className="rounded-xl bg-green-50/60 p-3 sm:p-4"
      >
        <div className="mb-3 flex items-start gap-2">
          <Sprout
            className="mt-0.5 h-4 w-4 shrink-0 text-green-600"
            aria-hidden="true"
          />
          <div>
            <h2
              id={`plant-insights-${plantId}`}
              className="font-semibold text-gray-900"
            >
              Diagnóstico e cuidados
            </h2>
            <p className="text-xs text-gray-500">
              Informações geradas pelo diagnóstico, disponíveis somente para
              leitura.
            </p>
          </div>
        </div>
        {loading && (
          <p className="py-4 text-center text-sm text-gray-500">
            Carregando diagnóstico...
          </p>
        )}
        {error && (
          <p role="alert" className="py-4 text-center text-sm text-red-600">
            Erro ao carregar diagnóstico. Tente novamente mais tarde.
          </p>
        )}
        {!loading && !error && data?.diagnosis && (
          <PlantInsightsPanel insights={data} />
        )}
        {!loading && !error && !data?.diagnosis && (
          <p className="rounded-lg border border-dashed border-green-200 bg-white p-4 text-sm text-gray-600">
            Esta planta ainda não tem diagnóstico. Adicione uma foto e faça um
            diagnóstico para receber orientações de cuidados.
          </p>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onSave}
          className="flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          <Check className="h-3.5 w-3.5" /> Salvar
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600 focus-visible:ring-offset-2"
        >
          <X className="h-3.5 w-3.5" /> Cancelar
        </button>
      </div>
    </div>
  );
}

export default function PlantsPage() {
  const { projectId } = useProject();
  const [plants, setPlants] = useState<Plant[]>([]);
  const [thirstyPlantIds, setThirstyPlantIds] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [history, setHistory] = useState<DiagnosisHistoryEntry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    nome: "",
    localizacao: "",
    observacoes: "",
  });
  const [showCreateModal, setShowCreateModal] = useState(false);

  async function loadPlants() {
    setLoading(true);
    try {
      const list = await api.get<Plant[]>(`/projects/${projectId}/plants`);
      setPlants(list);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Falha ao carregar plantas",
      );
    } finally {
      setLoading(false);
    }
  }

  // "Com sede" = tem lembrete de rega pendente já vencido (hoje ou atrasado).
  // ponytail: detecta rega pelo prefixo "Regar " do título (mesma convenção de
  // plants-schedule.ts) em vez de um campo `tipo` dedicado no Reminder.
  async function loadThirsty() {
    try {
      const reminders = await api.get<Reminder[]>(
        `/projects/${projectId}/reminders`,
      );
      const today = new Date();
      const ids = reminders
        .filter(
          (r) =>
            r.status === "PENDENTE" &&
            r.titulo.startsWith("Regar ") &&
            new Date(r.data) <= today &&
            r.plantId,
        )
        .map((r) => r.plantId as string);
      setThirstyPlantIds(new Set(ids));
    } catch {
      setThirstyPlantIds(new Set());
    }
  }

  async function markHealthy(id: string) {
    try {
      await api.patch(`/projects/${projectId}/plants/${id}`, {
        ultimaSaude: "SAUDAVEL",
      });
      await loadPlants();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar saúde");
    }
  }

  useEffect(() => {
    loadPlants();
    loadThirsty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function toggleHistory(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    try {
      const list = await api.get<DiagnosisHistoryEntry[]>(
        `/projects/${projectId}/plants/${id}/diagnosticos`,
      );
      setHistory(list);
    } catch {
      setHistory([]);
    }
  }

  function startEdit(plant: Plant) {
    setEditingId(plant.id);
    setEditForm({
      nome: plant.nome,
      localizacao: plant.localizacao ?? "",
      observacoes: plant.observacoes ?? "",
    });
  }

  async function saveEdit(id: string) {
    try {
      await api.patch(`/projects/${projectId}/plants/${id}`, editForm);
      setEditingId(null);
      await loadPlants();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar");
    }
  }

  async function removePlant(id: string) {
    if (
      !confirm("Remover esta planta? O histórico de diagnósticos será perdido.")
    )
      return;
    try {
      await api.delete(`/projects/${projectId}/plants/${id}`);
      await loadPlants();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao remover");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Minhas Plantas</h1>
          <p className="text-sm text-gray-500 mt-1">
            Cadastre e acompanhe cada planta: última espécie identificada, saúde
            e histórico de diagnósticos.
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium shrink-0"
        >
          <Plus className="h-4 w-4" /> Nova planta
        </button>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-500">Carregando...</p>
      ) : plants.length === 0 ? (
        <div className="rounded-2xl border bg-white p-6 text-center">
          <Sprout className="mx-auto h-8 w-8 text-green-600" />
          <p className="text-sm text-gray-600 mt-2">
            Nenhuma planta cadastrada ainda.
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium"
          >
            <Plus className="h-4 w-4" /> Cadastrar primeira planta
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {plants.map((plant) => (
            <div key={plant.id} className="rounded-2xl border bg-white p-4">
              {editingId === plant.id ? (
                <PlantProfileForm
                  plantId={plant.id}
                  form={editForm}
                  onChange={setEditForm}
                  onSave={() => saveEdit(plant.id)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="relative shrink-0">
                        {plant.fotoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`${API_BASE}${plant.fotoUrl}`}
                            alt={plant.nome}
                            className="h-12 w-12 rounded-full object-cover border border-green-200"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded-full bg-green-50 border border-green-200 flex items-center justify-center">
                            <Sprout className="h-5 w-5 text-green-600" />
                          </div>
                        )}
                        {plant.ultimaSaude &&
                          plant.ultimaSaude !== "SAUDAVEL" && (
                            <span
                              title={`Saúde: ${plant.ultimaSaude}`}
                              className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 border-2 border-white flex items-center justify-center"
                            >
                              <HeartPulse className="h-3 w-3 text-white" />
                            </span>
                          )}
                        {thirstyPlantIds.has(plant.id) && (
                          <span
                            title="Precisa de água"
                            className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-sky-500 border-2 border-white flex items-center justify-center"
                          >
                            <Droplets className="h-3 w-3 text-white" />
                          </span>
                        )}
                      </div>
                      <div>
                        <p className="font-semibold text-gray-900">
                          {plant.nome}
                        </p>
                        {plant.localizacao && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            {plant.localizacao}
                          </p>
                        )}
                        {plant.especiePopular && (
                          <p className="text-sm text-gray-700 mt-1">
                            {plant.especiePopular}
                            {plant.especieCientifica && (
                              <span className="text-gray-400 italic">
                                {" "}
                                ({plant.especieCientifica})
                              </span>
                            )}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {plant.ultimaSaude && (
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full ${SAUDE_BADGE[plant.ultimaSaude] ?? "bg-gray-100 text-gray-600"}`}
                            >
                              saúde: {plant.ultimaSaude}
                            </span>
                          )}
                          {plant.ultimoRiscoPet && (
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full ${PET_BADGE[plant.ultimoRiscoPet] ?? "bg-gray-100 text-gray-600"}`}
                            >
                              pet: {plant.ultimoRiscoPet}
                            </span>
                          )}
                          {plant.ultimoDiagnosticoEm && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                              diagnosticado em{" "}
                              {formatDateBR(plant.ultimoDiagnosticoEm)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {plant.ultimaSaude &&
                        plant.ultimaSaude !== "SAUDAVEL" && (
                          <button
                            onClick={() => markHealthy(plant.id)}
                            className="p-1.5 rounded-lg hover:bg-gray-100"
                            title="Marcar como saudável"
                          >
                            <HeartPulse className="h-4 w-4 text-green-600" />
                          </button>
                        )}
                      <button
                        onClick={() => startEdit(plant)}
                        className="p-1.5 rounded-lg hover:bg-gray-100"
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4 text-gray-500" />
                      </button>
                      <button
                        onClick={() => removePlant(plant.id)}
                        className="p-1.5 rounded-lg hover:bg-gray-100"
                        title="Remover"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={() => toggleHistory(plant.id)}
                    className="text-xs text-brand-600 underline mt-3"
                  >
                    {expandedId === plant.id
                      ? "Ocultar histórico"
                      : "Ver histórico de diagnósticos"}
                  </button>

                  {expandedId === plant.id && (
                    <div className="mt-2 border-t pt-2">
                      {history.length === 0 ? (
                        <p className="text-xs text-gray-500">
                          Nenhum diagnóstico registrado ainda.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {history.map((h) => (
                            <li
                              key={h.id}
                              className="text-xs text-gray-600 flex flex-wrap gap-x-2"
                            >
                              <span className="font-mono text-gray-400">
                                {formatDateBR(h.createdAt)}
                              </span>
                              <span>{h.especiePopular ?? "—"}</span>
                              <span>· saúde: {h.saudeStatus ?? "—"}</span>
                              <span>· risco pet: {h.riscoPet ?? "—"}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreatePlantModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            loadPlants();
            loadThirsty();
          }}
        />
      )}
    </div>
  );
}
