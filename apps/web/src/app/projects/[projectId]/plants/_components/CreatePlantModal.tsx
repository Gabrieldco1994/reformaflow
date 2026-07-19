'use client';

import { useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Loader2, Sprout, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { checkImageQuality } from '@/lib/image-compress';
import { usePlantInsights } from '../_hooks/usePlantInsights';
import { PlantInsightsPanel } from './PlantInsightsPanel';

interface DiagnoseAndScheduleResult {
  plantId: string | null;
  diagnosis: {
    especieProvavel: { nomePopular: string; nomeCientifico: string; confianca: number };
  };
}

interface CreatePlantModalProps {
  onClose: () => void;
  onCreated: () => void;
  /** ponytail: skip the fixed overlay when embedded elsewhere (e.g. onboarding wizard) — same convention as the bank/card form modals. */
  bare?: boolean;
}

type Step = 'pick-photo' | 'diagnosing' | 'confirm-name' | 'manual-name';

interface ConfirmNameStepProps {
  plantId: string;
  suggestedName: string;
  manualName: string;
  setManualName: (name: string) => void;
  saving: boolean;
  showInsights: boolean;
  setShowInsights: (show: boolean) => void;
  onConfirm: () => void;
}

function ConfirmNameStep({
  plantId,
  suggestedName,
  manualName,
  setManualName,
  saving,
  showInsights,
  setShowInsights,
  onConfirm,
}: ConfirmNameStepProps) {
  const { projectId } = useProject();
  const { data: insights, loading: insightsLoading, error: insightsError } = usePlantInsights(projectId, plantId);

  return (
    <div className="space-y-3 max-h-96 overflow-y-auto">
      <p className="text-sm text-gray-700">
        {suggestedName ? (
          <>🌱 Identificamos como <strong>{suggestedName}</strong>. Pode ajustar o nome:</>
        ) : (
          <>Não conseguimos identificar a espécie, mas a planta já foi criada. Dê um nome pra ela:</>
        )}
      </p>
      <input
        autoFocus
        value={manualName || suggestedName}
        onChange={(e) => setManualName(e.target.value)}
        placeholder="Nome da planta"
        className="w-full rounded-lg border px-3 py-2 text-sm"
      />

      <button
        onClick={() => setShowInsights(!showInsights)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-gray-200 text-sm hover:bg-gray-50"
      >
        <span className="font-medium text-gray-700">Cuidados recomendados</span>
        {showInsights ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
      </button>

      {showInsights && insights && <PlantInsightsPanel insights={insights} isLoading={insightsLoading} isError={!!insightsError} />}

      <button
        disabled={saving}
        onClick={onConfirm}
        className="w-full px-4 py-2 rounded-lg bg-brand-600 text-white text-sm disabled:opacity-50"
      >
        {saving ? 'Salvando...' : 'Concluir'}
      </button>
    </div>
  );
}

export function CreatePlantModal({ onClose, onCreated, bare }: CreatePlantModalProps) {
  const { projectId } = useProject();
  const [step, setStep] = useState<Step>('pick-photo');
  const [error, setError] = useState<string | null>(null);
  const [suggestedName, setSuggestedName] = useState('');
  const [createdPlantId, setCreatedPlantId] = useState<string | null>(null);
  const [manualName, setManualName] = useState('');
  const [saving, setSaving] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  async function handleFilePicked(file: File | undefined) {
    if (!file) return;
    setError(null);

    const quality = await checkImageQuality(file);
    if (!quality.ok) {
      // ponytail: aviso não bloqueia — foto ruim ainda dá pra tentar diagnosticar.
      setError(quality.reason ?? null);
    }

    setStep('diagnosing');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('persist', 'true');
      const result = await api.upload<DiagnoseAndScheduleResult>(
        `/projects/${projectId}/plants-ai/diagnose-and-schedule`,
        formData,
      );
      setCreatedPlantId(result.plantId);
      setSuggestedName(result.diagnosis.especieProvavel?.nomePopular ?? '');
      setStep('confirm-name');
    } catch {
      // Diagnóstico falhou (IA fora do ar, cota estourada, etc.) — não bloqueia a
      // criação: deixa o usuário dar um nome manualmente e criar sem diagnóstico.
      setStep('manual-name');
    }
  }

  async function confirmName(finalName: string) {
    if (!createdPlantId || !finalName.trim() || finalName.trim() === suggestedName) {
      onCreated();
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/projects/${projectId}/plants/${createdPlantId}`, { nome: finalName.trim() });
    } catch {
      // nome sugerido pela IA já ficou salvo; falha aqui não é crítica.
    } finally {
      setSaving(false);
      onCreated();
    }
  }

  async function createManually() {
    const nome = manualName.trim();
    if (!nome) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/projects/${projectId}/plants`, { nome });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar planta');
      setSaving(false);
    }
  }

  const content = (
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <Sprout className="h-5 w-5 text-green-600" /> Nova planta
          </h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100" title="Fechar">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {error && <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">⚠ {error}</p>}

        {step === 'pick-photo' && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Tire ou envie uma foto da planta — a IA tenta identificar a espécie e já monta o
              cronograma de cuidados automaticamente.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => cameraInputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-5 hover:border-brand-400 hover:bg-brand-50"
              >
                <Camera className="h-6 w-6 text-brand-600" />
                <span className="text-sm font-medium text-gray-700">Tirar foto</span>
              </button>
              <button
                onClick={() => galleryInputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-5 hover:border-brand-400 hover:bg-brand-50"
              >
                <ImageIcon className="h-6 w-6 text-brand-600" />
                <span className="text-sm font-medium text-gray-700">Enviar foto</span>
              </button>
            </div>
            <button
              onClick={() => setStep('manual-name')}
              className="w-full text-center text-xs text-gray-500 underline"
            >
              Prefiro só dar um nome, sem foto agora
            </button>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => handleFilePicked(e.target.files?.[0])}
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFilePicked(e.target.files?.[0])}
            />
          </div>
        )}

        {step === 'diagnosing' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-6 w-6 text-brand-600 animate-spin" />
            <p className="text-sm text-gray-600">Analisando a foto...</p>
          </div>
        )}

        {step === 'confirm-name' && createdPlantId && (
          <ConfirmNameStep
            plantId={createdPlantId}
            suggestedName={suggestedName}
            manualName={manualName}
            setManualName={setManualName}
            saving={saving}
            showInsights={showInsights}
            setShowInsights={setShowInsights}
            onConfirm={() => confirmName(manualName || suggestedName)}
          />
        )}

        {step === 'manual-name' && (
          <div className="space-y-3">
            <input
              autoFocus
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="Nome da planta (ex: Jiboia da sala)"
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
            <button
              disabled={!manualName.trim() || saving}
              onClick={createManually}
              className="w-full px-4 py-2 rounded-lg bg-brand-600 text-white text-sm disabled:opacity-50"
            >
              {saving ? 'Criando...' : 'Criar planta'}
            </button>
          </div>
        )}
      </div>
  );
  if (bare) return content;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      {content}
    </div>
  );
}
