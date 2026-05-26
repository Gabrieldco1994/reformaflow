'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import { Plus, Trash2, ChevronRight, LineChart } from 'lucide-react';
import Link from 'next/link';
import { Modal } from '@/components/ui/modal';

interface Project {
  id: string;
  name: string;
  type: string;
  description?: string;
  createdAt: string;
}

const TYPE_CONFIG: Record<string, { icon: string; label: string; description: string; color: string }> = {
  REFORMA: { icon: '🏗️', label: 'Reforma', description: 'Controle financeiro e visual de reformas', color: 'bg-amber-50 border-amber-200' },
  COMPRA: { icon: '🏠', label: 'Compra', description: 'Acompanhe compras grandes (casa, carro, etc.)', color: 'bg-blue-50 border-blue-200' },
  PESSOAL: { icon: '💰', label: 'Pessoal', description: 'Controle de despesas e recebimentos pessoais', color: 'bg-rose-50 border-rose-200' },
  CASA: { icon: '🏡', label: 'Casa', description: 'Gerencie contas, manutenções e lembretes da casa', color: 'bg-green-50 border-green-200' },
  CARRO: { icon: '🚗', label: 'Carro', description: 'Controle manutenções, custos e lembretes do carro', color: 'bg-purple-50 border-purple-200' },
};

export default function ProjectsPage() {
  const router = useRouter();
  const { hasProjectType, isAdmin, user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', type: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

  const visibleProjects = useMemo(
    () => projects.filter((p) => hasProjectType(p.type)),
    [projects, hasProjectType],
  );

  const allowedTypes = useMemo(
    () => Object.keys(TYPE_CONFIG).filter((t) => hasProjectType(t)),
    [hasProjectType],
  );

  const canCreate = !!user && allowedTypes.length > 0;

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
    if (!allowedTypes.includes(newProject.type)) {
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
      router.push(`/projects/${created.id}/dashboard`);
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
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-darc-linen">
      <header className="bg-darc-maroon border-b border-darc-velvet px-4 md:px-6 py-2.5 md:py-4 mb-4 md:mb-6 shadow-darc-soft">
        <div className="max-w-4xl mx-auto flex items-baseline gap-2 md:gap-3">
          <h1 className="font-editorial text-2xl md:text-3xl text-darc-red leading-none">D&apos;arc</h1>
          <span className="text-[9px] md:text-[10px] tracking-[0.3em] uppercase text-darc-mist">Studio</span>
        </div>
      </header>
      <div className="max-w-4xl mx-auto px-4 md:px-6 pb-24 md:pb-0">
      {/* Header desktop */}
      <div className="hidden md:flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 md:mb-8">
        <div>
          <h1 className="font-editorial text-3xl text-darc-maroon italic">Meus Projetos</h1>
          <p className="text-darc-raspberry/80 mt-1 italic">Gerencie seus projetos de vida</p>
        </div>
        <button
          onClick={openCreate}
          disabled={!canCreate}
          className="self-start sm:self-auto flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={
            canCreate
              ? 'Criar novo projeto'
              : 'Você não tem módulos liberados para criar projetos'
          }
        >
          <Plus className="w-4 h-4" />
          Novo Projeto
        </button>
      </div>

      {/* Header mobile compacto */}
      <div className="md:hidden mb-4">
        <p className="text-[10px] uppercase tracking-[0.2em] text-darc-raspberry/70">Hub</p>
        <h1 className="font-editorial italic text-2xl text-darc-maroon leading-tight">
          Meus Projetos
        </h1>
      </div>

      {/* Card destaque: Visão Financeira Consolidada */}
      {visibleProjects.length > 0 && (
        <Link
          href="/financeiro"
          className="block mb-4 md:mb-6 rounded-2xl bg-gradient-to-br from-darc-velvet to-darc-maroon p-4 md:p-5 text-darc-linen hover:shadow-darc-hero active:scale-[0.99] transition-all"
        >
          <div className="flex items-center gap-3 md:gap-4">
            <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-darc-linen/15 flex items-center justify-center flex-shrink-0">
              <LineChart className="w-5 h-5 md:w-6 md:h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] tracking-[0.2em] uppercase text-darc-pink-logo/80">Visão Geral</p>
              <p className="font-editorial italic text-lg md:text-xl text-darc-linen leading-tight">Saúde financeira consolidada</p>
              <p className="text-xs md:text-sm text-darc-linen/70 mt-0.5">Todos os seus projetos juntos</p>
            </div>
            <ChevronRight className="w-5 h-5 text-darc-linen/60 flex-shrink-0" />
          </div>
        </Link>
      )}

      {/* Modal de criação (sheet em mobile, center em desktop) */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Novo Projeto"
        size="md"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nome</label>
            <input
              type="text"
              value={newProject.name}
              onChange={(e) => setNewProject((p) => ({ ...p, name: e.target.value }))}
              className="w-full border border-darc-linen rounded-lg px-3 py-2 focus:ring-2 focus:ring-darc-mist focus:border-darc-mist"
              placeholder="Ex: Reforma do Apartamento"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Tipo do Projeto</label>
            {allowedTypes.length === 0 ? (
              <div className="text-sm text-gray-500 bg-darc-linen/40 border border-darc-linen rounded-lg p-3">
                Você não tem módulos liberados para criar projetos. Peça ao administrador.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {allowedTypes.map((key) => {
                  const cfg = TYPE_CONFIG[key]!;
                  return (
                    <button
                      key={key}
                      onClick={() => setNewProject((p) => ({ ...p, type: key }))}
                      className={`p-3 rounded-lg border-2 text-left transition-all ${
                        newProject.type === key
                          ? 'border-darc-red-bright bg-darc-pink-logo/30 ring-2 ring-darc-red-pastel/30'
                          : 'border-darc-linen hover:border-darc-raspberry/40'
                      }`}
                    >
                      <span className="text-2xl">{cfg.icon}</span>
                      <div className="font-medium mt-1 text-darc-velvet">{cfg.label}</div>
                      <div className="text-xs text-darc-velvet/60 leading-snug">{cfg.description}</div>
                    </button>
                  );
                })}
              </div>
            )}
            {!isAdmin && allowedTypes.length < Object.keys(TYPE_CONFIG).length && (
              <p className="text-xs text-darc-velvet/50 mt-2">
                Apenas os tipos para os quais você tem módulos liberados aparecem aqui.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Descrição (opcional)</label>
            <textarea
              value={newProject.description}
              onChange={(e) => setNewProject((p) => ({ ...p, description: e.target.value }))}
              className="w-full border border-darc-linen rounded-lg px-3 py-2 focus:ring-2 focus:ring-darc-mist focus:border-darc-mist"
              rows={2}
              placeholder="Breve descrição do projeto"
            />
          </div>

          {createError && (
            <div className="text-sm text-darc-red bg-darc-red-pastel/10 border border-darc-red-pastel/40 rounded-lg px-3 py-2">
              {createError}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-darc-linen">
          <button
            onClick={() => setShowCreate(false)}
            className="px-4 py-2 text-darc-velvet/70 hover:text-darc-velvet"
          >
            Cancelar
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !newProject.name.trim() || !newProject.type}
            className="px-4 py-2 bg-darc-red-bright text-white rounded-lg hover:bg-darc-red-pastel disabled:opacity-50"
          >
            {creating ? 'Criando...' : 'Criar Projeto'}
          </button>
        </div>
      </Modal>

      {/* Lista de projetos */}
      {visibleProjects.length === 0 ? (
        <div className="text-center py-12 md:py-16 bg-white rounded-2xl border border-darc-linen shadow-darc-soft">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-darc-velvet font-medium">
            {projects.length === 0 ? 'Nenhum projeto ainda' : 'Você não tem acesso a nenhum projeto'}
          </p>
          <p className="text-darc-velvet/50 text-sm mt-1 px-6">
            {projects.length === 0
              ? canCreate
                ? 'Crie seu primeiro projeto para começar'
                : 'Peça ao administrador para liberar módulos'
              : 'Peça ao administrador para liberar módulos'}
          </p>
          {canCreate && (
            <button
              onClick={openCreate}
              className="mt-4 px-4 py-2 bg-darc-red-bright text-white rounded-lg hover:bg-darc-red-pastel"
            >
              Criar Projeto
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-2.5 md:gap-4">
          {visibleProjects.map((project) => {
            const cfg = TYPE_CONFIG[project.type] ?? TYPE_CONFIG.REFORMA;
            return (
              <div
                key={project.id}
                className={`flex items-center gap-3 md:gap-4 px-3 md:px-4 py-2.5 md:py-4 rounded-xl border cursor-pointer hover:shadow-darc-soft active:scale-[0.99] transition-all ${cfg.color}`}
                onClick={() => router.push(`/projects/${project.id}/dashboard`)}
              >
                <span className="text-xl md:text-3xl flex-shrink-0">{cfg.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-darc-velvet text-sm md:text-base truncate">{project.name}</div>
                  <div className="text-xs md:text-sm text-darc-velvet/60 flex items-center gap-2 mt-0.5">
                    <span className="px-1.5 md:px-2 py-0.5 rounded-full bg-white/70 text-[10px] md:text-xs font-medium text-darc-velvet flex-shrink-0">{cfg.label}</span>
                    {project.description && <span className="truncate hidden md:inline">{project.description}</span>}
                  </div>
                </div>
                {isAdmin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(project.id); }}
                    className="hidden md:block p-2 text-darc-velvet/40 hover:text-darc-red transition-colors"
                    title="Excluir projeto"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                <ChevronRight className="md:hidden w-4 h-4 text-darc-velvet/40 flex-shrink-0" />
              </div>
            );
          })}
        </div>
      )}

      {/* FAB mobile */}
      {canCreate && (
        <button
          type="button"
          onClick={openCreate}
          aria-label="Novo projeto"
          className="md:hidden fixed bottom-20 right-4 z-40 w-14 h-14 rounded-full bg-darc-red-bright text-white shadow-darc-med flex items-center justify-center hover:bg-darc-red-pastel active:scale-95 transition-all"
        >
          <Plus className="w-6 h-6" />
        </button>
      )}
    </div>
    </div>
  );
}
