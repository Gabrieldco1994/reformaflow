'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, ALL_MODULES, type ModuleSlug, type AuthUser } from '@/contexts/auth-context';
import { api } from '@/lib/api';

interface AdminUser extends AuthUser {
  createdAt?: string;
  updatedAt?: string;
}

const PROJECT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'REFORMA', label: 'Reforma' },
  { value: 'COMPRA', label: 'Compra' },
  { value: 'PESSOAL', label: 'Pessoal' },
  { value: 'CASA', label: 'Casa' },
  { value: 'CARRO', label: 'Carro' },
];

export default function AdminUsersPage() {
  const { user, isAdmin, loading } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!isAdmin) {
      router.replace('/no-permission');
    }
  }, [loading, user, isAdmin, router]);

  async function reload() {
    setError(null);
    try {
      const data = await api.get<AdminUser[]>('/users');
      setUsers(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar usuários');
    }
  }

  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin]);

  if (loading || !isAdmin) return null;

  async function handleDelete(u: AdminUser) {
    if (!confirm(`Excluir usuário ${u.username}?`)) return;
    setBusy(true);
    try {
      await api.delete(`/users/${u.id}`);
      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erro ao excluir');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Usuários</h1>
          <div className="flex gap-2">
            <a
              href="/"
              className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5"
            >
              ← Voltar
            </a>
            <button
              onClick={() => setShowCreate(true)}
              className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-4 py-2 rounded-lg"
            >
              + Novo usuário
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Nome
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Usuário
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Papel
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Módulos
                </th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3 font-medium text-gray-900">{u.name}</td>
                  <td className="px-4 py-3 text-gray-700">{u.username}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        u.role === 'ADMIN'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {u.role === 'ADMIN'
                      ? 'Todos'
                      : u.allowedModules.length === 0
                        ? '—'
                        : u.allowedModules.length + ' módulo(s)'}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      onClick={() => setEditing(u)}
                      className="text-sm text-brand-700 hover:underline"
                    >
                      Editar
                    </button>
                    {u.id !== user?.id && (
                      <button
                        disabled={busy}
                        onClick={() => handleDelete(u)}
                        className="text-sm text-red-600 hover:underline"
                      >
                        Excluir
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <UserFormModal
          mode="create"
          onClose={() => setShowCreate(false)}
          onSaved={async () => {
            setShowCreate(false);
            await reload();
          }}
        />
      )}

      {editing && (
        <UserFormModal
          mode="edit"
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function UserFormModal({
  mode,
  user,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  user?: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(user?.name ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'USER'>(
    (user?.role as 'ADMIN' | 'USER') ?? 'USER',
  );
  const [allowedModules, setAllowedModules] = useState<ModuleSlug[]>(
    (user?.allowedModules as ModuleSlug[]) ?? [],
  );
  const [allowedProjects, setAllowedProjects] = useState<string[]>(
    user?.allowedProjects ?? [],
  );
  const [allowedProjectTypes, setAllowedProjectTypes] = useState<string[]>(
    user?.allowedProjectTypes ?? [],
  );
  const [projects, setProjects] = useState<{ id: string; name: string; type: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ id: string; name: string; type: string }[]>('/projects')
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  function toggleModule(slug: ModuleSlug) {
    setAllowedModules((curr) =>
      curr.includes(slug) ? curr.filter((s) => s !== slug) : [...curr, slug],
    );
  }

  function toggleProject(id: string) {
    setAllowedProjects((curr) =>
      curr.includes(id) ? curr.filter((p) => p !== id) : [...curr, id],
    );
  }

  function toggleProjectType(type: string) {
    setAllowedProjectTypes((curr) =>
      curr.includes(type) ? curr.filter((t) => t !== type) : [...curr, type],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'create') {
        await api.post('/users', {
          name,
          username,
          password,
          role,
          allowedModules,
          allowedProjects,
          allowedProjectTypes,
        });
      } else if (user) {
        const payload: Record<string, unknown> = {
          name,
          username,
          role,
          allowedModules,
          allowedProjects,
          allowedProjectTypes,
        };
        if (password) payload['password'] = password;
        await api.patch(`/users/${user.id}`, payload);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="p-5 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {mode === 'create' ? 'Novo usuário' : 'Editar usuário'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Nome
            </label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Usuário
            </label>
            <input
              type="text"
              autoComplete="off"
              required
              minLength={3}
              maxLength={40}
              pattern="[a-zA-Z0-9._-]+"
              title="Apenas letras, números, ponto, hífen ou sublinhado"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              {mode === 'create' ? 'Senha' : 'Nova senha (deixe em branco para manter)'}
            </label>
            <input
              type="password"
              required={mode === 'create'}
              minLength={mode === 'create' ? 6 : 0}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Papel
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'ADMIN' | 'USER')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="USER">Usuário</option>
              <option value="ADMIN">Administrador</option>
            </select>
          </div>

          {role === 'USER' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">
                Módulos liberados
              </label>
              <div className="grid grid-cols-2 gap-2">
                {ALL_MODULES.map((m) => (
                  <label
                    key={m.slug}
                    className="flex items-center gap-2 text-sm cursor-pointer p-2 rounded hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={allowedModules.includes(m.slug)}
                      onChange={() => toggleModule(m.slug)}
                    />
                    <span>{m.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {role === 'USER' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">
                Tipos que pode criar
                <span className="ml-1 font-normal text-gray-400">
                  (nenhum marcado = pode criar os tipos que os módulos permitem)
                </span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {PROJECT_TYPE_OPTIONS.map((t) => (
                  <label
                    key={t.value}
                    className="flex items-center gap-2 text-sm cursor-pointer p-2 rounded hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={allowedProjectTypes.includes(t.value)}
                      onChange={() => toggleProjectType(t.value)}
                    />
                    <span>{t.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {role === 'USER' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">
                Projetos liberados
                <span className="ml-1 font-normal text-gray-400">
                  (nenhum marcado = vê todos os permitidos pelo módulo/tipo)
                </span>
              </label>
              {projects.length === 0 ? (
                <p className="text-xs text-gray-400">Nenhum projeto disponível.</p>
              ) : (
                <div className="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto">
                  {projects.map((p) => (
                    <label
                      key={p.id}
                      className="flex items-center gap-2 text-sm cursor-pointer p-2 rounded hover:bg-gray-50"
                    >
                      <input
                        type="checkbox"
                        checked={allowedProjects.includes(p.id)}
                        onChange={() => toggleProject(p.id)}
                      />
                      <span className="truncate">{p.name}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-400">
                        {p.type}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-gray-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-lg"
          >
            {submitting ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  );
}
