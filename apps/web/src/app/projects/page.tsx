'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import { useJourneyRuntime } from '@/contexts/journey-runtime-context';
import type { ProjectType } from '@reformaflow/domain';
import { Plus, ChevronRight, Search, Settings } from 'lucide-react';
import Link from 'next/link';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';
import { ProjectHubCard } from './_components/ProjectHubCard';
import { CreateProjectModal } from './_components/CreateProjectModal';
import { typeAccent, TypeIcon } from './_components/type-accent';
import { getProjectHomePath } from './_lib/project-home-route';
import { OBJECTIVE_TYPES } from '@/components/objectives/objective-options';

interface Project {
  id: string;
  name: string;
  type: string;
  description?: string;
  createdAt: string;
  onboardedAt?: string | null;
}

export default function ProjectsPage() {
  const router = useRouter();
  const { hasProjectType, hasProjectAccess, canCreateProjectType, isAdmin, user, refresh } = useAuth();
  const { emitProjectsCreated } = useJourneyRuntime();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', type: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onboarding, setOnboarding] = useState(false);

  useEffect(() => {
    setOnboarding(new URLSearchParams(window.location.search).get('onboarding') === '1');
    loadProjects();
  }, []);

  const visibleProjects = useMemo(
    () => projects.filter((p) => hasProjectType(p.type) && hasProjectAccess(p.id)),
    [projects, hasProjectType, hasProjectAccess],
  );

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visibleProjects;
    return visibleProjects.filter((p) => {
      const label = typeAccent(p.type).label.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        label.includes(q)
      );
    });
  }, [visibleProjects, query]);

  const allowedTypes = useMemo(
    () => OBJECTIVE_TYPES.filter((type) => canCreateProjectType(type)),
    [canCreateProjectType],
  );

  const canCreate = !!user && allowedTypes.length > 0;

  useEffect(() => {
    if (!loading && onboarding && projects.length === 0 && canCreate) {
      setNewProject({ name: '', type: allowedTypes[0] ?? '', description: '' });
      setCreateError(null);
      setShowCreate(true);
      setOnboarding(false);
    }
  }, [allowedTypes, canCreate, loading, onboarding, projects.length]);

  function openCreate() {
    if (!canCreate) return;
    setNewProject({
      name: '',
      type: allowedTypes[0] ?? '',
      description: '',
    });
    setCreateError(null);
    setShowCreate(true);
  }

  async function loadProjects() {
    try {
      const data = await api.get<Project[]>('/projects');
      setProjects(data);
    } catch (err) {
      console.error('Erro ao carregar projetos:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newProject.name.trim() || !newProject.type) return;
    if (!allowedTypes.some((type) => type === newProject.type)) {
      setCreateError('Você não tem permissão para criar projetos desse tipo.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.post<Project>('/projects', newProject);
      setProjects((prev) => [created, ...prev]);
      setShowCreate(false);
      setNewProject({ name: '', type: allowedTypes[0] ?? '', description: '' });
      // Recarrega o usuário: se restrito, o backend acabou de conceder acesso
      // ao novo projeto — sem isso o layout redirecionaria para /no-permission.
      await refresh();
      void emitProjectsCreated([{ id: created.id, type: created.type as ProjectType }]);
      // Primeiro acesso ao projeto: o painel de onboarding aparecerá na dashboard
      // via o trigger PROJECT_CREATED (Fase A da jornada), não via rota dedicada
      // como era no shell antigo.
      //
      // `getProjectHomePath`, NUNCA `/projects/${id}` cru: não existe `page.tsx`
      // em `projects/[projectId]/` (só layout/loading/error), então a rota crua é
      // 404. Quando a jornada dispara e navega para a tela do primeiro passo, ela
      // encobre o 404 por acaso — mas quem já concluiu o onboarding daquele tipo
      // fica no "This page could not be found", com o painel da jornada boiando
      // sobre a página de erro. Os outros dois pontos de navegação desta tela já
      // usavam o helper.
      router.push(getProjectHomePath(created.id, created.type));
    } catch (err) {
      console.error('Erro ao criar projeto:', err);
      setCreateError(err instanceof Error ? err.message : 'Erro ao criar projeto');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Tem certeza que deseja excluir este projeto?')) return;
    try {
      await api.delete(`/projects/${id}`);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error('Erro ao excluir:', err);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-lifeone-surface flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-lifeone-blue"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-lifeone-surface font-geist">
      <div className="max-w-5xl mx-auto px-5 md:px-10 pt-8 md:pt-14 pb-24 md:pb-16">
        {/* Header */}
        <div className="flex items-start sm:items-center justify-between gap-4 mb-7 md:mb-9">
          <div>
            <p className="text-[13px] font-semibold tracking-[0.08em] uppercase text-lifeone-ink-3">
              LifeOne
            </p>
            <h1 className="font-geist not-italic text-[28px] md:text-[34px] font-bold text-lifeone-ink tracking-[-0.03em] leading-tight" style={{ fontFamily: "'Geist', var(--font-sans), system-ui, sans-serif", fontStyle: 'normal' }}>
              Meus Projetos
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {!isAdmin && (
              <Link
                href="/settings"
                aria-label="Configurações"
                title="Configurações"
                className="flex min-h-11 min-w-11 items-center justify-center rounded-[10px] text-lifeone-ink-3 hover:bg-lifeone-card hover:text-lifeone-blue"
              >
                <Settings className="h-5 w-5" />
              </Link>
            )}
            <NotificationsBell variant="light" />
            <button
              onClick={openCreate}
              disabled={!canCreate}
              className="hidden md:flex items-center gap-2 px-4 py-2.5 bg-lifeone-blue text-[#FFFFFF] text-[14px] font-semibold rounded-[10px] hover:brightness-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              title={canCreate ? 'Criar novo projeto' : 'Você não tem módulos liberados para criar projetos'}
              data-journey-action="project.new"
            >
              <Plus className="w-4 h-4" />
              Novo Projeto
            </button>
          </div>
        </div>

        {/* Busca de projetos */}
        {visibleProjects.length > 0 && (
          <div className="mb-4 md:mb-5 flex items-center gap-2.5 rounded-[14px] bg-lifeone-card border border-lifeone-hairline px-4 py-3 shadow-lifeone-card">
            <Search className="w-[19px] h-[19px] text-lifeone-ink-4 flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar projeto…"
              aria-label="Buscar projeto"
              className="flex-1 bg-transparent border-0 outline-none text-[15px] text-lifeone-ink placeholder:text-lifeone-ink-4"
            />
          </div>
        )}

        <CreateProjectModal
          open={showCreate}
          onClose={() => setShowCreate(false)}
          newProject={newProject}
          setNewProject={setNewProject}
          allowedTypes={allowedTypes}
          totalTypes={OBJECTIVE_TYPES.length}
          isAdmin={isAdmin}
          creating={creating}
          createError={createError}
          onCreate={handleCreate}
        />

        {/* Lista / grade de projetos */}
        {visibleProjects.length === 0 ? (
          <div className="text-center py-16 bg-lifeone-card rounded-[18px] border border-lifeone-hairline shadow-lifeone-card">
            <p className="text-4xl mb-3">📋</p>
            <p className="text-lifeone-ink font-semibold text-[15px]">
              {projects.length === 0 ? 'Nenhum projeto ainda' : 'Você não tem acesso a nenhum projeto'}
            </p>
            <p className="text-lifeone-ink-3 text-[13px] mt-1 px-6">
              {projects.length === 0
                ? canCreate
                  ? 'Dê um nome ao seu primeiro projeto e escolha um dos objetivos liberados para começar.'
                  : 'Peça ao administrador para liberar módulos'
                : 'Peça ao administrador para liberar módulos'}
            </p>
            {canCreate && (
              <button
                onClick={openCreate}
                className="mt-4 px-4 py-2.5 bg-lifeone-blue text-[#FFFFFF] text-[14px] font-semibold rounded-[10px] hover:brightness-95 transition-all"
              >
                Criar Projeto
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Sem resultado para a busca */}
            {filteredProjects.length === 0 && (
              <div className="text-center py-12 text-lifeone-ink-4 text-[14px]">
                Nenhum projeto encontrado para “{query}”.
              </div>
            )}

            {/* Desktop: grade 3 colunas com add-card */}
            <div className="hidden md:grid grid-cols-3 gap-4">
              {filteredProjects.map((project) => (
                <ProjectHubCard
                  key={project.id}
                  project={project}
                  isAdmin={isAdmin}
                  onOpen={() => router.push(getProjectHomePath(project.id, project.type))}
                  onDelete={(e) => { e.stopPropagation(); handleDelete(project.id); }}
                />
              ))}
              {canCreate && (
                <button
                  onClick={openCreate}
                  className="flex flex-col items-center justify-center gap-2 min-h-[152px] rounded-[18px] border-2 border-dashed border-lifeone-hairline text-lifeone-ink-3 hover:border-lifeone-blue hover:text-lifeone-blue transition-all"
                >
                  <Plus className="w-6 h-6" />
                  <span className="text-[14px] font-medium">Novo Projeto</span>
                </button>
              )}
            </div>

            {/* Mobile: lista de cards */}
            <div className="md:hidden grid gap-2.5">
              {filteredProjects.map((project) => {
                const accent = typeAccent(project.type);
                return (
                  <div
                    key={project.id}
                    onClick={() => router.push(getProjectHomePath(project.id, project.type))}
                    className="flex items-center gap-3 px-3.5 py-3 rounded-[14px] bg-lifeone-card border border-lifeone-hairline shadow-lifeone-card active:scale-[0.99] transition-all"
                  >
                    <span
                      className="w-11 h-11 rounded-[12px] flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: accent.fill }}
                    >
                      <TypeIcon type={project.type} className="w-5 h-5" style={{ color: accent.color }} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-lifeone-ink text-[15px] truncate">{project.name}</div>
                      <div className="text-[12px] text-lifeone-ink-3 flex items-center gap-2 mt-0.5">
                        <span
                          className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-[0.04em] flex-shrink-0"
                          style={{ backgroundColor: accent.fill, color: accent.color }}
                        >
                          {accent.label}
                        </span>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-lifeone-ink-4 flex-shrink-0" />
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* FAB mobile */}
        {canCreate && (
          <button
            type="button"
            onClick={openCreate}
            aria-label="Novo projeto"
            data-journey-action="project.new"
            className="md:hidden fixed bottom-20 right-4 z-40 w-14 h-14 rounded-full bg-lifeone-blue text-[#FFFFFF] shadow-lifeone-fab flex items-center justify-center active:scale-95 transition-all"
          >
            <Plus className="w-6 h-6" />
          </button>
        )}
      </div>
    </div>
  );
}
