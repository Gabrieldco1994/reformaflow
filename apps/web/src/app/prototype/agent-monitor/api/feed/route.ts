import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextResponse } from 'next/server';

type FeedPayload = {
  updatedAt: string;
  agents: Array<{
    agentId: string;
    name: string;
    kind?: 'agent' | 'subagent';
    status?: 'running' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'unknown';
    task?: string | null;
    updatedAt?: string;
    detail?: string | null;
    sessionId?: string | null;
    parentAgentId?: string | null;
  }>;
};

export const runtime = 'nodejs';

function resolveFeedFile() {
  return (
    process.env.AGENT_MONITOR_FEED_FILE ??
    path.join(os.homedir(), '.copilot', 'session-state', 'agent-monitor-feed.json')
  );
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 404 });
  }

  const expectedToken = process.env.AGENT_MONITOR_FEED_TOKEN;
  if (expectedToken) {
    const incoming = request.headers.get('x-monitor-token');
    if (incoming !== expectedToken) {
      return NextResponse.json({ error: 'Unauthorized feeder' }, { status: 401 });
    }
  }

  let payload: FeedPayload;
  try {
    payload = (await request.json()) as FeedPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!payload?.updatedAt || !Array.isArray(payload.agents)) {
    return NextResponse.json({ error: 'Payload requires updatedAt and agents[]' }, { status: 400 });
  }

  const normalized = {
    updatedAt: payload.updatedAt,
    agents: payload.agents.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      kind: agent.kind ?? 'agent',
      status: agent.status ?? 'unknown',
      task: agent.task ?? null,
      updatedAt: agent.updatedAt ?? payload.updatedAt,
      detail: agent.detail ?? null,
      sessionId: agent.sessionId ?? null,
      parentAgentId: agent.parentAgentId ?? null,
    })),
  };

  const filePath = resolveFeedFile();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8');

  return NextResponse.json({ ok: true, filePath, count: normalized.agents.length });
}
