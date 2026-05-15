'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import { Plus, Trash2 } from 'lucide-react';

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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 mb-6">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <span className="text-2xl">🎯</span>
          <h1 className="text-xl font-bold text-gray-900">Controle de Vida</h1>
        </div>
      </header>
      <div className="max-w-4xl mx-auto px-6">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Meus Projetos</h1>
          <p className="text-gray-500 mt-1">Gerencie seus projetos de vida</p>
        </div>
        <button
          onClick={openCreate}
          disabled={!canCreate}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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

      {/* Modal de criação */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg shadow-xl">
            <h2 className="text-xl font-bold mb-4">Novo Projeto</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nome</label>
                <input
                  type="text"
                  value={newProject.name}
                  onChange={(e) => setNewProject((p) => ({ ...p, name: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  placeholder="Ex: Reforma do Apartamento"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Tipo do Projeto</label>
                {allowedTypes.length === 0 ? (
                  <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">
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
                              ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-200'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <span className="text-2xl">{cfg.icon}</span>
                          <div className="font-medium mt-1">{cfg.label}</div>
                          <div className="text-xs text-gray-500">{cfg.description}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {!isAdmin && allowedTypes.length < Object.keys(TYPE_CONFIG).length && (
                  <p className="text-xs text-gray-400 mt-2">
                    Apenas os tipos para os quais você tem módulos liberados aparecem aqui.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Descrição (opcional)</label>
                <textarea
                  value={newProject.description}
                  onChange={(e) => setNewProject((p) => ({ ...p, description: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-brand-500"
                  rows={2}
                  placeholder="Breve descrição do projeto"
                />
              </div>

              {createError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {createError}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-gray-600 hover:text-gray-800"
              >
                Cancelar
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newProject.name.trim() || !newProject.type}
                className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
              >
                {creating ? 'Criando...' : 'Criar Projeto'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lista de projetos */}
      {visibleProjects.length === 0 ? (
        <div className="text-center py-16 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200">
          <p className="text-4xl mb-4">📋</p>
          <p className="text-gray-600 font-medium">
            {projects.length === 0 ? 'Nenhum projeto ainda' : 'Você não tem acesso a nenhum projeto'}
          </p>
          <p className="text-gray-400 text-sm mt-1">
            {projects.length === 0
              ? canCreate
                ? 'Crie seu primeiro projeto para começar'
                : 'Peça ao administrador para liberar módulos'
              : 'Peça ao administrador para liberar módulos'}
          </p>
          {canCreate && (
            <button
              onClick={openCreate}
              className="mt-4 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"
            >
              Criar Projeto
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          {visibleProjects.map((project) => {
            const cfg = TYPE_CONFIG[project.type] ?? TYPE_CONFIG.REFORMA;
            return (
              <div
                key={project.id}
                className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer hover:shadow-md transition-shadow ${cfg.color}`}
                onClick={() => router.push(`/projects/${project.id}/dashboard`)}
              >
                <span className="text-3xl">{cfg.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-900">{project.name}</div>
                  <div className="text-sm text-gray-500 flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full bg-white/60 text-xs font-medium">{cfg.label}</span>
                    {project.description && <span className="truncate">{project.description}</span>}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(project.id); }}
                  disabled={!isAdmin}
                  className="p-2 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-gray-400"
                  title={isAdmin ? 'Excluir projeto' : 'Apenas administradores podem excluir'}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
    </div>
  );
}
