'use client';

import { useEffect, useState } from 'react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { checkImageQuality } from '@/lib/image-compress';

interface Plant {
  id: string;
  nome: string;
  localizacao: string | null;
  especiePopular: string | null;
  ultimaSaude: string | null;
  ultimoRiscoPet: string | null;
  ultimoDiagnosticoEm: string | null;
}

interface Diagnosis {
  especieProvavel: {
    nomePopular: string;
    nomeCientifico: string;
    confianca: number;
  };
  especiesAlternativas?: Array<{
    nomePopular: string;
    nomeCientifico: string;
    confianca: number;
  }>;
  saude: {
    status: 'SAUDAVEL' | 'ATENCAO' | 'CRITICA';
    confianca: number;
    sinais: string[];
  };
  pet: {
    risco: 'SEGURO' | 'CAUTELA' | 'TOXICA' | 'DESCONHECIDO';
    observacao: string;
    fonteReferencia?: 'ASPCA' | 'desconhecido';
  };
  cuidados: {
    rega: string;
    luz: string;
    poda: string;
    adubacao: string;
    solo: string;
  };
  problemasPossiveis: Array<{
    nome: string;
    gravidade: 'BAIXA' | 'MEDIA' | 'ALTA';
    probabilidade: number;
    descricao: string;
    planoAcao: string[];
  }>;
  qualidadeImagem?: {
    status: 'BOA' | 'LIMITADA' | 'RUIM';
    motivos: string[];
    recomendarNovaFoto: boolean;
  };
}

interface DiagnosisHistoryEntry {
  id: string;
  createdAt: string;
  especiePopular: string | null;
  especieCientifica: string | null;
  saudeStatus: string | null;
  riscoPet: string | null;
}

export default function PlantsAiPage() {
  const { projectId } = useProject();
  const [plants, setPlants] = useState<Plant[]>([]);
  const [plantId, setPlantId] = useState<string>('');
  const [newPlantName, setNewPlantName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [persistSchedule, setPersistSchedule] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [scheduleInfo, setScheduleInfo] = useState<{ reminders: number; maintenance: number } | null>(null);
  const [history, setHistory] = useState<DiagnosisHistoryEntry[]>([]);
  const [qualityWarning, setQualityWarning] = useState<string | null>(null);
  const [checkingQuality, setCheckingQuality] = useState(false);

  async function loadPlants() {
    try {
      const list = await api.get<Plant[]>(`/projects/${projectId}/plants`);
      setPlants(list);
    } catch {
      // silencioso: lista de plantas é auxiliar, diagnóstico funciona sem ela
    }
  }

  async function loadHistory(id: string) {
    if (!id) {
      setHistory([]);
      return;
    }
    try {
      const list = await api.get<DiagnosisHistoryEntry[]>(`/projects/${projectId}/plants/${id}/diagnosticos`);
      setHistory(list);
    } catch {
      setHistory([]);
    }
  }

  useEffect(() => {
    loadPlants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    loadHistory(plantId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantId]);

  async function handleAddPlant() {
    const trimmedName = newPlantName.trim();
    if (!trimmedName || !file || loading) return;
    setError(null);
    setDiagnosis(null);
    setScheduleInfo(null);
    setLoading(true);

    let created: Plant;
    try {
      created = await api.post<Plant>(`/projects/${projectId}/plants`, { nome: trimmedName });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar planta');
      setLoading(false);
      return;
    }

    setNewPlantName('');
    setPlantId(created.id);
    await loadPlants();

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('plantId', created.id);
      formData.append('persist', 'true');
      const result = await api.upload<{
        diagnosis: Diagnosis;
        schedule: { persisted: { reminders: number; maintenance: number } };
      }>(
        `/projects/${projectId}/plants-ai/diagnose-and-schedule`,
        formData,
      );
      setDiagnosis(result.diagnosis);
      setScheduleInfo(result.schedule.persisted);
      await loadHistory(created.id);
    } catch {
      setError('Planta criada, mas o diagnóstico falhou. Tente novamente para esta planta.');
    } finally {
      setLoading(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setFile(picked);
    setQualityWarning(null);
    if (!picked) return;
    setCheckingQuality(true);
    try {
      const check = await checkImageQuality(picked);
      if (!check.ok) setQualityWarning(check.reason ?? 'Foto com qualidade baixa');
    } finally {
      setCheckingQuality(false);
    }
  }

  async function handleDiagnose() {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('persist', persistSchedule ? 'true' : 'false');
      if (plantId) formData.append('plantId', plantId);
      const result = await api.upload<{
        diagnosis: Diagnosis;
        schedule: { persisted: { reminders: number; maintenance: number } };
      }>(
        `/projects/${projectId}/plants-ai/diagnose-and-schedule`,
        formData,
      );
      setDiagnosis(result.diagnosis);
      setScheduleInfo(result.schedule.persisted);
      if (plantId) {
        await loadPlants();
        await loadHistory(plantId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao diagnosticar');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Diagnóstico IA</h1>
        <p className="text-sm text-gray-500 mt-1">
          Envie uma foto da planta para identificar espécie, saúde, risco para pet e plano de cuidados.
        </p>
      </header>

      <div className="rounded-2xl border bg-white p-4 space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Planta (opcional)</label>
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={plantId}
              onChange={(e) => setPlantId(e.target.value)}
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="">Sem planta específica</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                  {p.especiePopular ? ` — ${p.especiePopular}` : ''}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Nova planta (ex: Jiboia da sala)"
              value={newPlantName}
              onChange={(e) => setNewPlantName(e.target.value)}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <button
              onClick={handleAddPlant}
              disabled={!newPlantName.trim() || !file || loading}
              className="px-3 py-2 rounded-lg border text-sm disabled:opacity-50"
            >
              {loading ? 'Processando...' : '+ Adicionar planta'}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Escolha a foto abaixo antes de adicionar: a planta nova já sai diagnosticada
            automaticamente. Vincular a uma planta salva o histórico de diagnósticos e nomeia
            os lembretes/cuidados gerados.
          </p>
          {plantId && history.length > 0 && (
            <div className="mt-3 border-t pt-3">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Histórico de diagnósticos</h3>
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="text-xs text-gray-600 flex flex-wrap gap-x-2">
                    <span className="font-mono text-gray-400">
                      {new Date(h.createdAt).toLocaleDateString('pt-BR')}
                    </span>
                    <span>{h.especiePopular ?? '—'}</span>
                    <span>· saúde: {h.saudeStatus ?? '—'}</span>
                    <span>· risco pet: {h.riscoPet ?? '—'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="block w-full text-sm"
        />
        {checkingQuality && <p className="text-xs text-gray-500">Checando qualidade da foto...</p>}
        {qualityWarning && (
          <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
            ⚠ {qualityWarning} — você ainda pode diagnosticar, mas o resultado pode ficar impreciso.
          </p>
        )}
        <button
          onClick={handleDiagnose}
          disabled={!file || loading}
          className="px-4 py-2 rounded-lg bg-brand-600 text-white disabled:opacity-50"
        >
          {loading ? 'Analisando...' : 'Diagnosticar'}
        </button>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={persistSchedule}
            onChange={(e) => setPersistSchedule(e.target.checked)}
          />
          Salvar cronograma automaticamente em Cuidados/Lembretes
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {scheduleInfo && (
          <p className="text-sm text-green-700">
            Cronograma salvo: {scheduleInfo.reminders} lembrete(s), {scheduleInfo.maintenance} cuidado(s).
          </p>
        )}
      </div>

      {diagnosis && (
        <div className="rounded-2xl border bg-white p-4 space-y-4">
          <section>
            <h2 className="font-semibold text-gray-900">Espécie provável</h2>
            <p className="text-sm text-gray-700">
              {diagnosis.especieProvavel.nomePopular} ({diagnosis.especieProvavel.nomeCientifico}) ·
              {' '}confiança {Math.round(diagnosis.especieProvavel.confianca * 100)}%
            </p>
            {diagnosis.especiesAlternativas && diagnosis.especiesAlternativas.length > 0 && (
              <p className="text-sm text-gray-600 mt-1">
                Alternativas: {diagnosis.especiesAlternativas.map((e) => e.nomePopular).join(', ')}
              </p>
            )}
          </section>

          <section>
            <h2 className="font-semibold text-gray-900">Saúde</h2>
            <p className="text-sm text-gray-700">
              {diagnosis.saude.status} · confiança {Math.round(diagnosis.saude.confianca * 100)}%
            </p>
            {diagnosis.saude.sinais.length > 0 && (
              <ul className="list-disc ml-5 text-sm text-gray-700 mt-1">
                {diagnosis.saude.sinais.map((s) => <li key={s}>{s}</li>)}
              </ul>
            )}
          </section>

          <section>
            <h2 className="font-semibold text-gray-900">Risco para pet</h2>
            <p className="text-sm text-gray-700">
              {diagnosis.pet.risco} — {diagnosis.pet.observacao}
            </p>
            {diagnosis.pet.fonteReferencia && (
              <p className="text-xs text-gray-500 mt-1">Fonte: {diagnosis.pet.fonteReferencia}</p>
            )}
          </section>

          {diagnosis.qualidadeImagem && (
            <section>
              <h2 className="font-semibold text-gray-900">Qualidade da imagem</h2>
              <p className="text-sm text-gray-700">
                {diagnosis.qualidadeImagem.status}
                {diagnosis.qualidadeImagem.recomendarNovaFoto ? ' · recomendável tirar nova foto' : ''}
              </p>
            </section>
          )}

          <section>
            <h2 className="font-semibold text-gray-900">Cuidados</h2>
            <ul className="list-disc ml-5 text-sm text-gray-700">
              <li>Rega: {diagnosis.cuidados.rega}</li>
              <li>Luz: {diagnosis.cuidados.luz}</li>
              <li>Poda: {diagnosis.cuidados.poda}</li>
              <li>Adubação: {diagnosis.cuidados.adubacao}</li>
              <li>Solo: {diagnosis.cuidados.solo}</li>
            </ul>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900">Problemas possíveis</h2>
            {diagnosis.problemasPossiveis.length === 0 ? (
              <p className="text-sm text-gray-700">Nenhum problema evidente.</p>
            ) : (
              <div className="space-y-3">
                {diagnosis.problemasPossiveis.map((p) => (
                  <div key={`${p.nome}-${p.gravidade}`} className="rounded-lg border p-3">
                    <p className="text-sm font-medium text-gray-900">
                      {p.nome} · {p.gravidade} · {Math.round(p.probabilidade * 100)}%
                    </p>
                    <p className="text-sm text-gray-700 mt-1">{p.descricao}</p>
                    <ul className="list-disc ml-5 text-sm text-gray-700 mt-1">
                      {p.planoAcao.map((a) => <li key={a}>{a}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
