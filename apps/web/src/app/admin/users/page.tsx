'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, ALL_MODULES, type ModuleSlug, type AuthUser } from '@/contexts/auth-context';
import { api } from '@/lib/api';

interface AdminUser extends AuthUser {
  email?: string | null;
  createdAt?: string;
  updatedAt?: string;
  createdByName?: string | null;
  lastLoginAt?: string | null;
  lastActivityAt?: string | null;
  tenantName?: string | null;
  projectsCreatedCount?: number;
  expensesCreatedCount?: number;
}

function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const PROJECT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'REFORMA', label: 'Reforma' },
  { value: 'COMPRA', label: 'Compra' },
  { value: 'PESSOAL', label: 'Pessoal' },
  { value: 'CASA', label: 'Casa' },
  { value: 'CARRO', label: 'Carro' },
  { value: 'PLANTAS', label: 'Plantas' },
];

interface Feedback {
  id: string;
  userId: string;
  username: string;
  message: string;
  createdAt: string;
}

export default function AdminUsersPage() {
  const { user, isAdmin, loading } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackWarning, setFeedbackWarning] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [todayFilter, setTodayFilter] = useState<'none' | 'logged' | 'created' | 'existing'>('none');
  const [activityUser, setActivityUser] = useState<AdminUser | null>(null);

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
    setFeedbackWarning(null);
    try {
      const usersData = await api.get<AdminUser[]>('/users?scope=all');
      setUsers(usersData);

      try {
        const feedbacksData = await api.get<Feedback[]>('/feedback');
        setFeedbacks(feedbacksData);
      } catch {
        // ponytail: feedback não pode derrubar a tela de usuários
        setFeedbacks([]);
        setFeedbackWarning('Feedbacks indisponíveis no momento.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar usuários');
    }
  }

  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin]);

  if (loading || !isAdmin) return null;

  async function handleForceLogout(u: AdminUser) {
    if (!confirm(`Encerrar sessão de ${u.username}? O usuário será desconectado na próxima requisição.`)) return;
    setBusy(true);
    try {
      await api.post(`/users/${u.id}/force-logout`, {});
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erro ao encerrar sessão');
    } finally {
      setBusy(false);
    }
  }

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

  async function handleDeleteTenant(u: AdminUser) {
    const tenantUsers = users.filter((other) => other.tenantId === u.tenantId);
    const typed = prompt(
      `Excluir o tenant "${u.tenantName ?? u.tenantId}", ${tenantUsers.length} usuário(s) e todos os projetos dele?\n` +
        `Digite o nome do tenant para confirmar:`,
    );
    if (typed !== (u.tenantName ?? u.tenantId)) return;
    setBusy(true);
    try {
      await api.delete(`/tenants/${u.tenantId}`);
      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erro ao excluir tenant');
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
        {feedbackWarning && (
          <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm rounded-lg px-3 py-2 mb-4">
            {feedbackWarning}
          </div>
        )}

        {/* Stats bar */}
        {users.length > 0 && (() => {
          const now = Date.now();
          const d7 = 7 * 24 * 60 * 60 * 1000;
          const d30 = 30 * 24 * 60 * 60 * 1000;
          const startOfToday = new Date();
          startOfToday.setHours(0, 0, 0, 0);
          const startOfTomorrow = new Date(startOfToday);
          startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
          const lastSeen = (u: AdminUser) => u.lastActivityAt ?? u.lastLoginAt ?? null;
          const isInToday = (value?: string | null) => {
            if (!value) return false;
            const t = new Date(value).getTime();
            return t >= startOfToday.getTime() && t < startOfTomorrow.getTime();
          };
          const total = users.length;
          const admins = users.filter((u) => u.role === 'ADMIN').length;
          const active7d = users.filter((u) => { const t = lastSeen(u); return t && now - new Date(t).getTime() < d7; }).length;
          const active30d = users.filter((u) => { const t = lastSeen(u); return t && now - new Date(t).getTime() < d30; }).length;
          const loggedToday = users.filter((u) => isInToday(u.lastLoginAt)).length;
          const createdToday = users.filter((u) => isInToday(u.createdAt)).length;
          const loggedTodayExisting = users.filter((u) => {
            if (!isInToday(u.lastLoginAt)) return false;
            if (!u.createdAt) return true;
            return new Date(u.createdAt).getTime() < startOfToday.getTime();
          }).length;
          const never = users.filter((u) => !lastSeen(u)).length;
          return (
            <div className="grid grid-cols-8 gap-3 mb-4">
              {[
                { label: 'Total', value: total, color: 'text-gray-900' },
                { label: 'Admins', value: admins, color: 'text-purple-700' },
                { label: 'Ativos 7d', value: active7d, color: 'text-green-700' },
                { label: 'Ativos 30d', value: active30d, color: 'text-blue-700' },
                { label: 'Logaram hoje', value: loggedToday, color: 'text-brand-700', filterKey: 'logged' as const },
                { label: 'Cadastros hoje', value: createdToday, color: 'text-emerald-700', filterKey: 'created' as const },
                { label: 'Login hoje (existentes)', value: loggedTodayExisting, color: 'text-indigo-700', filterKey: 'existing' as const },
                { label: 'Nunca acessaram', value: never, color: 'text-gray-400' },
              ].map((s) => (
                <div
                  key={s.label}
                  onClick={s.filterKey ? () => setTodayFilter((v) => (v === s.filterKey ? 'none' : s.filterKey)) : undefined}
                  className={`bg-white border rounded-xl px-4 py-3 text-center transition-all ${
                    s.filterKey
                      ? 'cursor-pointer hover:border-brand-400 ' + (todayFilter === s.filterKey ? 'border-brand-500 ring-2 ring-brand-200' : 'border-gray-200')
                      : 'border-gray-200'
                  }`}
                >
                  <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{s.label}{s.filterKey && todayFilter === s.filterKey ? ' ✓' : ''}</div>
                </div>
              ))}
            </div>
          );
        })()}

        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          {todayFilter !== 'none' && (
            <div className="px-4 py-2 bg-brand-50 border-b border-brand-100 flex items-center justify-between">
              <span className="text-xs text-brand-700 font-medium">
                Filtro: {todayFilter === 'logged' ? 'logaram hoje' : todayFilter === 'created' ? 'cadastros hoje' : 'login hoje (existentes)'}
              </span>
              <button onClick={() => setTodayFilter('none')} className="text-xs text-brand-600 hover:underline">Limpar</button>
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Tenant
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Nome
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Usuário
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Email
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Papel
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase">
                  Módulos
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase whitespace-nowrap">
                  Criado por
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase whitespace-nowrap">
                  Projetos criados
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase whitespace-nowrap">
                  Despesas criadas
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase whitespace-nowrap">
                  Última atividade
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-600 uppercase whitespace-nowrap">
                  Cadastro
                </th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(todayFilter !== 'none'
                ? users.filter((u) => {
                    const startOfToday = new Date();
                    startOfToday.setHours(0, 0, 0, 0);
                    const startOfTomorrow = new Date(startOfToday);
                    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
                    const isInToday = (value?: string | null) => {
                      if (!value) return false;
                      const t = new Date(value).getTime();
                      return t >= startOfToday.getTime() && t < startOfTomorrow.getTime();
                    };
                    if (todayFilter === 'logged') return isInToday(u.lastLoginAt);
                    if (todayFilter === 'created') return isInToday(u.createdAt);
                    if (!isInToday(u.lastLoginAt)) return false;
                    if (!u.createdAt) return true;
                    return new Date(u.createdAt).getTime() < startOfToday.getTime();
                  })
                : users
              ).map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3 text-xs text-gray-700 whitespace-nowrap">
                    {u.tenantName ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">{u.name}</td>
                  <td className="px-4 py-3 text-gray-700">{u.username}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{u.email ?? '—'}</td>
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
                  <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                    {u.createdByName ?? 'Auto-cadastro'}
                  </td>
                  <td className="px-4 py-3 text-xs font-medium text-gray-900 whitespace-nowrap">
                    {u.projectsCreatedCount ?? 0}
                  </td>
                  <td className="px-4 py-3 text-xs font-medium text-gray-900 whitespace-nowrap">
                    {u.expensesCreatedCount ?? 0}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                    {formatDateTime(u.lastActivityAt ?? u.lastLoginAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                    {formatDateTime(u.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    <button
                      onClick={() => setActivityUser(u)}
                      className="text-sm text-gray-500 hover:text-gray-800 hover:underline"
                    >
                      Atividade
                    </button>
                    {u.tenantId === user?.tenantId ? (
                      <>
                        <button
                          onClick={() => setEditing(u)}
                          className="text-sm text-brand-700 hover:underline"
                        >
                          Editar
                        </button>
                      {u.id !== user?.id && (
                          <>
                            <button
                              disabled={busy}
                              onClick={() => handleForceLogout(u)}
                              className="text-sm text-amber-600 hover:underline"
                            >
                              Sair
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => handleDelete(u)}
                              className="text-sm text-red-600 hover:underline"
                            >
                              Excluir
                            </button>
                          </>
                        )}
                      </>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => handleDeleteTenant(u)}
                        className="text-sm text-red-600 hover:underline"
                        title="Exclui o tenant, seus usuários e projetos (soft-delete)"
                      >
                        Excluir tenant
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

      {activityUser && (
        <ActivityModal user={activityUser} onClose={() => setActivityUser(null)} />
      )}

      {/* Feedbacks section */}
      {feedbacks.length > 0 && (
        <div className="max-w-4xl mx-auto mt-8">
          <h2 className="text-lg font-bold text-gray-900 mb-3">Feedbacks ({feedbacks.length})</h2>
          <div className="flex flex-col gap-3">
            {feedbacks.map((fb) => (
              <div key={fb.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-gray-800">{fb.username}</span>
                  <span className="text-xs text-gray-400">
                    {new Date(fb.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{fb.message}</p>
              </div>
            ))}
          </div>
        </div>
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

interface ActivityData {
  summary: { action: string; count: number }[];
  recent: { id: string; action: string; createdAt: string }[];
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    'expenses.create': 'Criou despesa', 'expenses.update': 'Editou despesa', 'expenses.delete': 'Excluiu despesa',
    'projects.create': 'Criou projeto', 'projects.update': 'Editou projeto', 'projects.delete': 'Excluiu projeto',
    'receipts.create': 'Adicionou recibo', 'receipts.update': 'Editou recibo', 'receipts.delete': 'Excluiu recibo',
    'recurring-bill.create': 'Criou conta fixa', 'recurring-bill.update': 'Editou conta fixa',
    'maintenance.create': 'Criou manutenção', 'reminder.create': 'Criou lembrete',
    'cash-flow.create': 'Lançou caixa', 'cash-flow.update': 'Editou caixa',
    'credit-card.create': 'Criou cartão', 'bank-account.create': 'Criou conta',
    'schedule.create': 'Criou tarefa', 'schedule.update': 'Editou tarefa',
  };
  return labels[action] ?? action;
}

function ActivityModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<ActivityData>(`/users/${user.id}/activity`)
      .then(setData)
      .catch(() => setData({ summary: [], recent: [] }))
      .finally(() => setLoading(false));
  }, [user.id]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Atividade — {user.name}</h2>
            <p className="text-xs text-gray-500">{user.username} · {user.tenantName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5">
          {loading ? (
            <p className="text-sm text-gray-500 text-center py-8">Carregando…</p>
          ) : !data || (data.summary.length === 0 && data.recent.length === 0) ? (
            <p className="text-sm text-gray-500 text-center py-8">Nenhuma ação registrada ainda.</p>
          ) : (
            <>
              {data.summary.length > 0 && (
                <div className="mb-5">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Resumo por ação</h3>
                  <div className="flex flex-wrap gap-2">
                    {data.summary.map((s) => (
                      <span key={s.action} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-gray-100 text-xs text-gray-700">
                        {actionLabel(s.action)}
                        <span className="font-bold text-gray-900">{s.count}×</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {data.recent.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Últimas ações</h3>
                  <ul className="divide-y divide-gray-100">
                    {data.recent.map((r) => (
                      <li key={r.id} className="flex items-center justify-between py-2">
                        <span className="text-sm text-gray-700">{actionLabel(r.action)}</span>
                        <span className="text-xs text-gray-400 whitespace-nowrap ml-4">{new Date(r.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
