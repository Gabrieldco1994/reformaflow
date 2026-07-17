'use client';

import { useEffect, useMemo, useState } from 'react';

type SessionItem = {
  id: string;
  repo: string | null;
  branch: string | null;
  updatedAt: string | null;
  active: boolean;
  checkpointCount: number;
  lastCheckpoint: string | null;
  lastDebugEventAt: string | null;
  status: 'active' | 'idle';
};

type AgentItem = {
  agentId: string;
  name: string;
  kind: 'agent' | 'subagent';
  status: 'running' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  task: string | null;
  updatedAt: string;
  detail?: string | null;
  sessionId?: string | null;
  parentAgentId?: string | null;
};

type Snapshot = {
  now: string;
  source: { sessionStateRoot: string; debugLogsRoot: string; agentFeedFile: string };
  sessions: SessionItem[];
  agents: AgentItem[];
  feedUpdatedAt: string | null;
};

type AgentRow = {
  agent: AgentItem;
  depth: number;
};

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR');
}

export function AgentMonitorClient() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<'all' | 'active' | 'idle'>('all');
  const [agentFilter, setAgentFilter] = useState<
    'all' | 'running' | 'completed' | 'idle' | 'failed' | 'cancelled' | 'unknown'
  >('all');

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch('/prototype/agent-monitor/api/snapshot', {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`Falha ao ler snapshot (${response.status})`);
        }
        const payload = (await response.json()) as Snapshot;
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erro desconhecido');
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const activeCount = useMemo(
    () => data?.sessions.filter((session) => session.status === 'active').length ?? 0,
    [data],
  );
  const runningAgents = useMemo(
    () => data?.agents.filter((agent) => agent.status === 'running').length ?? 0,
    [data],
  );
  const completedAgents = useMemo(
    () => data?.agents.filter((agent) => agent.status === 'completed').length ?? 0,
    [data],
  );

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionItem>();
    data?.sessions.forEach((session) => map.set(session.id, session));
    return map;
  }, [data?.sessions]);

  const agentRows = useMemo(() => {
    if (!data) return [] as AgentRow[];

    const byParent = new Map<string | null, AgentItem[]>();
    for (const agent of data.agents) {
      const key = agent.parentAgentId ?? null;
      const bucket = byParent.get(key) ?? [];
      bucket.push(agent);
      byParent.set(key, bucket);
    }

    for (const bucket of byParent.values()) {
      bucket.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }

    const rows: AgentRow[] = [];
    const visited = new Set<string>();

    const walk = (agent: AgentItem, depth: number) => {
      if (visited.has(agent.agentId)) return;
      visited.add(agent.agentId);
      rows.push({ agent, depth });
      for (const child of byParent.get(agent.agentId) ?? []) {
        walk(child, depth + 1);
      }
    };

    const roots = [
      ...(byParent.get(null) ?? []),
      ...data.agents.filter((agent) => agent.parentAgentId && !data.agents.some((x) => x.agentId === agent.parentAgentId)),
    ];

    for (const root of roots) {
      walk(root, 0);
    }

    for (const agent of data.agents) {
      if (!visited.has(agent.agentId)) walk(agent, 0);
    }

    return rows;
  }, [data]);

  const filteredSessions = useMemo(() => {
    if (!data) return [] as SessionItem[];
    if (sessionFilter === 'all') return data.sessions;
    return data.sessions.filter((session) => session.status === sessionFilter);
  }, [data, sessionFilter]);

  const filteredAgentRows = useMemo(() => {
    if (agentFilter === 'all') return agentRows;
    return agentRows.filter(({ agent }) => agent.status === agentFilter);
  }, [agentFilter, agentRows]);

  return (
    <main className="min-h-screen bg-[#111] text-zinc-100 p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="space-y-1">
          <h1 className="text-xl md:text-2xl font-semibold">Monitor de sessões/agentes (MVP)</h1>
          <p className="text-sm text-zinc-400">
            Atualização a cada 2s. Status ativo usa lock de sessão.
          </p>
        </header>

        {data && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-300">
            <p>Última leitura: {formatDate(data.now)}</p>
            <p>Sessões: {data.sessions.length}</p>
            <p>Ativas: {activeCount}</p>
            <p>Agentes (feed): {data.agents.length}</p>
            <p>Running: {runningAgents}</p>
            <p className="truncate">session-state: {data.source.sessionStateRoot}</p>
            <p className="truncate">debug-logs: {data.source.debugLogsRoot}</p>
            <p className="truncate">feed: {data.source.agentFeedFile}</p>
            <p>feed atualizado: {formatDate(data.feedUpdatedAt)}</p>
          </section>
        )}

        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </p>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <div className="border-b border-zinc-800 bg-zinc-900/70 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {([
                ['all', `Todas (${data?.sessions.length ?? 0})`],
                ['active', `Ativas (${activeCount})`],
                ['idle', `Idle (${(data?.sessions.length ?? 0) - activeCount})`],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSessionFilter(value)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    sessionFilter === value
                      ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-zinc-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <table className="min-w-full text-left text-sm">
            <thead className="bg-zinc-900">
              <tr className="text-zinc-300">
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Sessão</th>
                <th className="px-3 py-2">Repo/branch</th>
                <th className="px-3 py-2">Checkpoint</th>
                <th className="px-3 py-2">Última atividade</th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.map((session) => (
                <tr key={session.id} className="border-t border-zinc-800">
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs ${
                        session.status === 'active'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-zinc-700 text-zinc-200'
                      }`}
                    >
                      {session.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{session.id}</td>
                  <td className="px-3 py-2">
                    <p>{session.repo ?? '—'}</p>
                    <p className="text-xs text-zinc-400">{session.branch ?? '—'}</p>
                  </td>
                  <td className="px-3 py-2">
                    <p>{session.lastCheckpoint ?? '—'}</p>
                    <p className="text-xs text-zinc-400">{session.checkpointCount} total</p>
                  </td>
                  <td className="px-3 py-2">
                    <p>debug: {formatDate(session.lastDebugEventAt)}</p>
                    <p className="text-xs text-zinc-400">workspace: {formatDate(session.updatedAt)}</p>
                  </td>
                </tr>
              ))}
              {data && filteredSessions.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-zinc-400" colSpan={5}>
                    Nenhuma sessão no filtro selecionado.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <div className="border-b border-zinc-800 bg-zinc-900/70 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {([
                ['all', `Todos (${data?.agents.length ?? 0})`],
                ['running', `Em andamento (${runningAgents})`],
                ['completed', `Completos (${completedAgents})`],
                ['idle', `Idle (${data?.agents.filter((agent) => agent.status === 'idle').length ?? 0})`],
                ['failed', `Falhou (${data?.agents.filter((agent) => agent.status === 'failed').length ?? 0})`],
                ['cancelled', `Cancelado (${data?.agents.filter((agent) => agent.status === 'cancelled').length ?? 0})`],
                ['unknown', `Unknown (${data?.agents.filter((agent) => agent.status === 'unknown').length ?? 0})`],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setAgentFilter(value)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    agentFilter === value
                      ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-zinc-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <table className="min-w-full text-left text-sm">
            <thead className="bg-zinc-900">
              <tr className="text-zinc-300">
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Agente/subagente</th>
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2">Sessão vinculada</th>
                <th className="px-3 py-2">Atualizado</th>
                <th className="px-3 py-2">Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {filteredAgentRows.map(({ agent, depth }) => {
                const session = agent.sessionId ? sessionById.get(agent.sessionId) : undefined;
                return (
                  <tr key={agent.agentId} className="border-t border-zinc-800">
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs ${
                          agent.status === 'running'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : agent.status === 'failed'
                              ? 'bg-red-500/20 text-red-300'
                              : 'bg-zinc-700 text-zinc-200'
                        }`}
                      >
                        {agent.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium" style={{ paddingLeft: `${depth * 14}px` }}>
                        {depth > 0 ? '└─ ' : ''}
                        {agent.name}
                      </p>
                      <p className="font-mono text-xs text-zinc-400">{agent.agentId}</p>
                      <p className="text-xs text-zinc-500">
                        {agent.kind}
                        {agent.parentAgentId ? ` · parent: ${agent.parentAgentId}` : ''}
                      </p>
                    </td>
                    <td className="px-3 py-2">{agent.task ?? '—'}</td>
                    <td className="px-3 py-2">
                      {agent.sessionId ? (
                        <>
                          <p className="font-mono text-xs">{agent.sessionId}</p>
                          <p className="text-xs text-zinc-400">{session?.branch ?? 'sessão não encontrada'}</p>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2">{formatDate(agent.updatedAt)}</td>
                    <td className="px-3 py-2 text-zinc-400">{agent.detail ?? '—'}</td>
                  </tr>
                );
              })}
              {data && filteredAgentRows.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-zinc-400" colSpan={6}>
                    Nenhum agente no filtro selecionado.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
