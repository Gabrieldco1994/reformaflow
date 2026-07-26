'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, RotateCcw, Save } from 'lucide-react';
import { ProjectType } from '@reformaflow/domain';
import { useAuth } from '@/contexts/auth-context';
import { useJourneyEditor } from './_hooks/useJourneyEditor';
import { JourneyTrack } from './_components/JourneyTrack';
import { PROJECT_TYPE_LABELS } from './_types';

const TYPES = Object.values(ProjectType);

/**
 * Painel do admin para configurar a jornada de onboarding de cada tipo de
 * projeto. A jornada é desenhada como uma TRILHA de telinhas na ordem em que a
 * pessoa as vê — arrastar reordena, o interruptor tira a tela do fluxo e o
 * lápis reescreve os textos. Salvar é por tipo de projeto.
 */
export default function AdminJornadasPage() {
  const { user, isAdmin, loading: authLoading } = useAuth();
  const router = useRouter();
  const [projectType, setProjectType] = useState<ProjectType>(ProjectType.PESSOAL);
  const editor = useJourneyEditor(projectType);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!isAdmin) router.replace('/no-permission');
  }, [authLoading, user, isAdmin, router]);

  async function handleSave() {
    try {
      await editor.save();
      toast.success(`Jornada de ${PROJECT_TYPE_LABELS[projectType]} salva.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível salvar a jornada.');
    }
  }

  if (!isAdmin) return null;

  const activeCount = editor.steps.filter((step) => step.enabled).length;

  return (
    <main className="min-h-screen bg-lifeone-canvas px-4 py-6 font-geist sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <header className="mb-5">
          <a href="/admin/users" className="mb-3 inline-flex items-center gap-1 text-[12px] text-lifeone-ink-3 hover:text-lifeone-ink">
            ← Usuários
          </a>
          <h1 className="text-[22px] font-bold text-lifeone-ink">Jornadas de onboarding</h1>
          <p className="mt-1 text-[13px] text-lifeone-ink-2">
            A trilha abaixo é o que a pessoa vê ao criar um projeto, na ordem em que vê. Arraste
            as telinhas para reordenar, desligue as que não fazem sentido e reescreva os textos.
          </p>
        </header>

        <nav aria-label="Tipo de projeto" className="mb-4 flex flex-wrap gap-2">
          {TYPES.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={type === projectType}
              onClick={() => setProjectType(type)}
              className={`min-h-11 rounded-full px-4 text-[13px] font-semibold transition-colors ${
                type === projectType
                  ? 'bg-lifeone-ink text-white'
                  : 'border border-lifeone-hairline bg-lifeone-card text-lifeone-ink-2 hover:border-lifeone-blue'
              }`}
            >
              {PROJECT_TYPE_LABELS[type] ?? type}
            </button>
          ))}
        </nav>

        <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[16px] font-bold text-lifeone-ink">
                Trilha de {PROJECT_TYPE_LABELS[projectType] ?? projectType}
              </h2>
              <p className="text-[12px] text-lifeone-ink-3">
                {activeCount} de {editor.steps.length} telas ligadas
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {editor.dirty && (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#FBEBDC] px-3 py-1 text-[12px] font-semibold text-[#B5803A]">
                  <AlertTriangle className="h-3.5 w-3.5" /> Alterações não salvas
                </span>
              )}
              <button
                type="button"
                onClick={editor.reset}
                disabled={!editor.dirty || editor.saving}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border border-lifeone-hairline px-3 text-[13px] font-medium text-lifeone-ink-2 disabled:opacity-40"
              >
                <RotateCcw className="h-4 w-4" /> Desfazer
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!editor.dirty || editor.saving}
                className="inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-lifeone-blue px-4 text-[13px] font-semibold text-white disabled:opacity-50"
              >
                {editor.saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Salvar jornada
              </button>
            </div>
          </div>

          {editor.error && (
            <p className="mb-3 rounded-[10px] bg-[#FDECEA] px-3 py-2 text-[13px] text-[#B42318]">
              Não foi possível carregar as jornadas: {editor.error.message}
            </p>
          )}

          {editor.loading ? (
            <p className="py-8 text-center text-[13px] text-lifeone-ink-3">Carregando trilha…</p>
          ) : editor.steps.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-lifeone-ink-3">
              Nenhuma tela configurável para este tipo de projeto.
            </p>
          ) : (
            <JourneyTrack
              steps={editor.steps}
              onReorder={editor.reorder}
              onMove={editor.moveStep}
              onPatch={editor.patchStep}
            />
          )}

          <p className="mt-2 text-[12px] text-lifeone-ink-3">
            As telas de criação do projeto e de conclusão são fixas — não entram na trilha.
          </p>
        </section>
      </div>
    </main>
  );
}
