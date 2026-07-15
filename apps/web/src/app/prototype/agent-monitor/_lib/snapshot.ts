import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MonitorSession = {
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

export type MonitorAgent = {
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

type AgentFeed = {
  updatedAt: string;
  agents: MonitorAgent[];
};

type WorkspaceMeta = {
  repo: string | null;
  branch: string | null;
  updatedAt: string | null;
};

function parseWorkspaceYaml(content: string): WorkspaceMeta {
  const lines = content.split('\n');
  const lookup = (key: string) =>
    lines.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? null;

  return {
    repo: lookup('repository'),
    branch: lookup('branch'),
    updatedAt: lookup('updated_at'),
  };
}

function parseLastDebugEventAt(debugLogPath: string): string | null {
  if (!existsSync(debugLogPath)) {
    return null;
  }

  const content = readFileSync(debugLogPath, 'utf-8').trim();
  if (!content) {
    return null;
  }

  const lines = content.split('\n');
  const last = lines[lines.length - 1];
  const event = JSON.parse(last) as { ts?: number };
  if (!event.ts) {
    return null;
  }
  return new Date(event.ts).toISOString();
}

function toCheckpointLabel(checkpointDir: string): string | null {
  if (!existsSync(checkpointDir)) {
    return null;
  }
  const files = readdirSync(checkpointDir)
    .filter((file) => file.endsWith('.md') && file !== 'index.md')
    .sort((a, b) => statSync(path.join(checkpointDir, b)).mtimeMs - statSync(path.join(checkpointDir, a)).mtimeMs);
  if (files.length === 0) {
    return null;
  }
  return files[0];
}

function resolveRoots() {
  const home = os.homedir();
  return {
    sessionStateRoot:
      process.env.COPILOT_SESSION_STATE_DIR ?? path.join(home, '.copilot', 'session-state'),
    debugLogsRoot:
      process.env.COPILOT_DEBUG_LOGS_DIR ??
      path.join(
        home,
        'Library',
        'Application Support',
        'Code',
        'User',
        'workspaceStorage',
        '36434a0f',
        'GitHub.copilot-chat',
        'debug-logs',
      ),
    agentFeedFile:
      process.env.AGENT_MONITOR_FEED_FILE ??
      path.join(home, '.copilot', 'session-state', 'agent-monitor-feed.json'),
  };
}

function deriveStatus(active: boolean): 'active' | 'idle' {
  return active ? 'active' : 'idle';
}

export function readMonitorSnapshot() {
  const { sessionStateRoot, debugLogsRoot, agentFeedFile } = resolveRoots();
  if (!existsSync(sessionStateRoot)) {
    return {
      sessions: [] as MonitorSession[],
      agents: [] as MonitorAgent[],
      feedUpdatedAt: null as string | null,
      source: { sessionStateRoot, debugLogsRoot, agentFeedFile },
    };
  }

  const sessions = readdirSync(sessionStateRoot)
    .filter((name) => existsSync(path.join(sessionStateRoot, name, 'workspace.yaml')))
    .map((id) => {
      const root = path.join(sessionStateRoot, id);
      const workspace = readFileSync(path.join(root, 'workspace.yaml'), 'utf-8');
      const { repo, branch, updatedAt } = parseWorkspaceYaml(workspace);

      const active = readdirSync(root).some((name) => name.startsWith('inuse.') && name.endsWith('.lock'));
      const checkpointDir = path.join(root, 'checkpoints');
      const checkpointCount = existsSync(checkpointDir)
        ? readdirSync(checkpointDir).filter((file) => file.endsWith('.md') && file !== 'index.md').length
        : 0;

      const lastDebugEventAt = parseLastDebugEventAt(path.join(debugLogsRoot, id, 'main.jsonl'));

      return {
        id,
        repo,
        branch,
        updatedAt,
        active,
        checkpointCount,
        lastCheckpoint: toCheckpointLabel(checkpointDir),
        lastDebugEventAt,
        status: deriveStatus(active),
      } satisfies MonitorSession;
    })
    .sort((a, b) => {
      const aTs = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bTs = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bTs - aTs;
    });

  let agents: MonitorAgent[] = [];
  let feedUpdatedAt: string | null = null;
  if (existsSync(agentFeedFile)) {
    try {
      const parsed = JSON.parse(readFileSync(agentFeedFile, 'utf-8')) as Partial<AgentFeed>;
      if (Array.isArray(parsed.agents)) {
        agents = parsed.agents
          .filter((item): item is MonitorAgent => Boolean(item?.agentId && item?.name && item?.updatedAt))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      }
      if (parsed.updatedAt) {
        feedUpdatedAt = parsed.updatedAt;
      }
    } catch {
      agents = [];
      feedUpdatedAt = null;
    }
  }

  const derivedAgents =
    agents.length > 0
      ? agents
      : sessions.map((session) => ({
          agentId: `session:${session.id}`,
          name: session.branch ? `session (${session.branch})` : 'session',
          kind: 'subagent' as const,
          status: session.active ? ('running' as const) : ('idle' as const),
          task: session.lastCheckpoint ? `checkpoint: ${session.lastCheckpoint}` : 'sem checkpoint recente',
          updatedAt: session.lastDebugEventAt ?? session.updatedAt ?? new Date().toISOString(),
          detail: session.repo ?? null,
          sessionId: session.id,
          parentAgentId: null,
        }));

  return {
    sessions,
    agents: derivedAgents,
    feedUpdatedAt,
    source: { sessionStateRoot, debugLogsRoot, agentFeedFile },
  };
}

export const _test = {
  parseWorkspaceYaml,
  deriveStatus,
};
