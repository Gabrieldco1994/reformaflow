'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { hasFeature } from '@reformaflow/domain';
import type {
  ProjectType,
  RefundPurposeRequest,
  RefundPurposeStateResponse,
  RefundPurposeSummary,
  UndoRefundPurposeRequest,
} from '@reformaflow/domain';
import { api, ApiResponseError } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import { invalidateExpenseProjects } from './useExpenseMutations';

export const REFUND_PURPOSE_COPY = {
  consultFailed: 'Não foi possível consultar a finalidade agora.',
  previewFailed: 'Não foi possível preparar esta finalidade.',
  applyFailed: 'Não foi possível confirmar esta finalidade.',
  undoFailed: 'Não foi possível desfazer esta finalidade.',
  lostApply: 'Não foi possível confirmar o resultado.',
  lostUndo: 'Não foi possível confirmar se a finalidade foi desfeita.',
  conflict: 'A finalidade mudou desde a última consulta. Consulte novamente antes de continuar.',
  catalogFailed: 'Não foi possível carregar os projetos de destino.',
  roomsLoading: 'Carregando ambientes…',
  roomsFailed: 'Não foi possível carregar os ambientes deste projeto.',
  targetLoading: 'Carregando…',
  targetFailed: 'Não foi possível carregar o destino.',
  roomFailed: 'Não foi possível carregar o ambiente.',
  roomUnavailable: 'Ambiente indisponível',
  noRoom: 'Sem ambiente',
} as const;

/** `GET /projects` rows: project columns only, never `rooms` (those come from the project detail). */
export interface CatalogProject {
  id: string;
  name: string;
  type: string;
}

/** What is consumed from `GET /projects/:id`; `rooms` keep the received order and include soft-deleted ones. */
export interface TargetProject {
  id: string;
  name: string;
  rooms: { id: string; name: string; deletedAt: string | null }[];
}
export type TargetProjectView =
  | { status: 'idle' | 'loading' | 'error'; project?: undefined; reload: () => void }
  | { status: 'ready'; project: TargetProject; reload: () => void };

interface PreviewState {
  targetProjectId: string;
  roomId: string | null;
  revision: number;
  fingerprint: string;
  summary: RefundPurposeSummary;
}

export type RefundPurposeProblem =
  | { kind: 'message'; text: string }
  | { kind: 'conflict' };
export type RefundPurposeNotice = 'lost-apply' | 'lost-undo';
export type RefundPurposeResult = 'applied' | 'already-applied' | 'undone' | 'already-undone';
type Busy = 'preview' | 'apply' | 'undo' | null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNullableString = (v: unknown) => v === null || typeof v === 'string';

function isSummary(v: unknown): v is RefundPurposeSummary {
  return (
    isRecord(v) &&
    typeof v.targetProjectId === 'string' &&
    isNullableString(v.roomId) &&
    typeof v.tipoDespesa === 'string' &&
    typeof v.allocationCents === 'number' &&
    Number.isFinite(v.allocationCents) &&
    isNullableString(v.dataCompra) &&
    typeof v.dataPagamento === 'string' &&
    typeof v.cashFlowDate === 'string'
  );
}

// Malformed bodies are errors, never a state: an unknown shape must not enable any action.
function parseState(body: unknown): RefundPurposeStateResponse {
  if (!isRecord(body) || typeof body.sourceExpenseId !== 'string' || !Array.isArray(body.actions)) {
    throw new Error('refund-purpose: malformed state');
  }
  if (!body.actions.every((a) => a === 'PREPARE' || a === 'UNDO')) throw new Error('refund-purpose: malformed actions');
  const assignment = body.assignment;
  if (assignment !== null) {
    if (!isRecord(assignment) || !Number.isInteger(assignment.revision) || !isSummary(assignment.summary)) {
      throw new Error('refund-purpose: malformed assignment');
    }
  }
  return body as unknown as RefundPurposeStateResponse;
}

// The detail is trusted only for what is consumed: expected id, name and every room's id/name/deletedAt.
function parseTargetProject(body: unknown, expectedId: string): TargetProject {
  if (!isRecord(body) || body.id !== expectedId || typeof body.name !== 'string' || !Array.isArray(body.rooms)) {
    throw new Error('project: malformed detail');
  }
  const rooms = body.rooms.map((room: unknown) => {
    if (!isRecord(room) || typeof room.id !== 'string' || typeof room.name !== 'string' || !isNullableString(room.deletedAt)) {
      throw new Error('project: malformed room');
    }
    return { id: room.id, name: room.name, deletedAt: room.deletedAt as string | null };
  });
  return { id: body.id, name: body.name, rooms };
}

function parsePreview(body: unknown): Omit<PreviewState, 'targetProjectId' | 'roomId'> | null {
  if (
    !isRecord(body) ||
    body.mode !== 'preview' ||
    !Number.isInteger(body.revision) ||
    typeof body.fingerprint !== 'string' ||
    body.fingerprint === '' ||
    !isSummary(body.summary)
  ) {
    return null;
  }
  return { revision: body.revision as number, fingerprint: body.fingerprint, summary: body.summary };
}

function parseApplied(body: unknown): { alreadyApplied: boolean } | null {
  if (!isRecord(body) || body.mode !== 'apply' || typeof body.alreadyApplied !== 'boolean') return null;
  return { alreadyApplied: body.alreadyApplied };
}

function parseUndone(body: unknown): { alreadyUndone: boolean } | null {
  if (!isRecord(body) || typeof body.revision !== 'number' || typeof body.alreadyUndone !== 'boolean') return null;
  return { alreadyUndone: body.alreadyUndone };
}

// Timeout, network failure and 5xx lose the response, not the effect: the outcome is unknown.
const isUncertain = (error: unknown) =>
  !(error instanceof ApiResponseError) || error.status >= 500 || error.status === 408;

// Per actor + project, only while the dialog is mounted; never refetched by focus/reconnect while editing.
function useTargetProject(userId: string | null, projectId: string): TargetProjectView {
  const query = useQuery<TargetProject>({
    queryKey: ['refund-purpose', 'target-project', userId, projectId],
    queryFn: async () => parseTargetProject(await api.get<unknown>(`/projects/${projectId}`), projectId),
    enabled: userId !== null && projectId !== '',
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const reload = () => void query.refetch();
  if (projectId === '' || userId === null) return { status: 'idle', reload };
  if (query.isError) return { status: 'error', reload };
  if (query.isFetching || query.data === undefined) return { status: 'loading', reload };
  return { status: 'ready', project: query.data, reload };
}

interface Args {
  /** Project of the Conta/screen where the user is (its views must refresh). */
  anchorProjectId: string;
  /** Project that REALLY owns the credit expense. */
  ownerProjectId: string;
  /** Real expense id (never a composite occurrence key). */
  expenseId: string;
  onBusyChange?: (busy: boolean) => void;
}

export function useRefundPurpose({ anchorProjectId, ownerProjectId, expenseId, onBusyChange }: Args) {
  const queryClient = useQueryClient();
  const { user, loading: authLoading, hasProjectAccess, hasModule, hasProjectType } = useAuth();
  const userId = user?.id ?? null;
  const path = `/projects/${ownerProjectId}/expenses/${expenseId}/refund-purpose`;

  // No static cache: every active open (and every explicit re-read) asks the server again.
  const read = useQuery<RefundPurposeStateResponse>({
    queryKey: ['refund-purpose', userId, ownerProjectId, expenseId],
    queryFn: async () => parseState(await api.get<unknown>(path)),
    enabled: userId !== null,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const [selection, setSelection] = useState({ projectId: '', roomId: '' });
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusyState] = useState<Busy>(null);
  const [confirmingUndo, setConfirmingUndo] = useState(false);
  const [notice, setNotice] = useState<RefundPurposeNotice | null>(null);
  const [problem, setProblem] = useState<RefundPurposeProblem | null>(null);
  const [result, setResult] = useState<RefundPurposeResult | null>(null);
  // After an unknown/conflicting write the last read no longer grants anything until re-read.
  const [stale, setStale] = useState(false);
  const busyRef = useRef<Busy>(null);
  const selectionVersion = useRef(0);

  const setBusy = useCallback((next: Busy) => {
    busyRef.current = next;
    setBusyState(next);
  }, []);
  useEffect(() => {
    onBusyChange?.(busy !== null);
  }, [busy, onBusyChange]);

  const readReady = !stale && !read.isFetching && !read.isError && read.data !== undefined;
  const state = readReady ? read.data : undefined;
  const canUndo = !!state && state.assignment !== null && state.actions.includes('UNDO') && busy === null;

  const canPrepare = !!state && state.actions.includes('PREPARE');
  const assignmentTargetId = state?.assignment?.summary.targetProjectId ?? '';

  const catalog = useQuery<CatalogProject[]>({
    queryKey: ['tenant', 'projects', userId],
    queryFn: async () => {
      const body = await api.get<unknown>('/projects');
      if (!Array.isArray(body)) throw new Error('projects: malformed catalog');
      return body as CatalogProject[];
    },
    enabled: userId !== null && canPrepare,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const selectedTarget = useTargetProject(userId, canPrepare ? selection.projectId : '');
  const assignmentTarget = useTargetProject(userId, assignmentTargetId);

  // New destinations follow the canonical grants + `expenses` capability and never the real source.
  // The server re-evaluates in the preview; this only avoids offering what cannot be chosen.
  const destinations = useMemo(
    () =>
      (catalog.data ?? []).filter(
        (p) =>
          p.id !== ownerProjectId &&
          hasProjectAccess(p.id) &&
          hasModule('expenses') &&
          hasProjectType(p.type) &&
          hasFeature(p.type as ProjectType, 'expenses'),
      ),
    [catalog.data, ownerProjectId, hasProjectAccess, hasModule, hasProjectType],
  );

  const refreshViews = useCallback(
    (targetProjectId: string | null | undefined) => {
      invalidateExpenseProjects(queryClient, [anchorProjectId, ownerProjectId, targetProjectId]);
    },
    [queryClient, anchorProjectId, ownerProjectId],
  );

  const reread = useCallback(async () => {
    setProblem(null);
    const outcome = await read.refetch();
    if (outcome.status === 'success') setStale(false);
  }, [read]);

  const selectProject = useCallback((projectId: string) => {
    selectionVersion.current += 1;
    setSelection({ projectId, roomId: '' });
    setPreview(null);
    setProblem(null);
  }, []);
  const selectRoom = useCallback((roomId: string) => {
    selectionVersion.current += 1;
    setSelection((current) => ({ ...current, roomId }));
    setPreview(null);
    setProblem(null);
  }, []);

  const requestPreview = useCallback(async () => {
    if (busyRef.current || !selection.projectId) return;
    const version = selectionVersion.current;
    const roomId = selection.roomId || null;
    const targetProjectId = selection.projectId;
    const body: RefundPurposeRequest = { mode: 'preview', targetProjectId, roomId };
    setBusy('preview');
    setProblem(null);
    setPreview(null);
    try {
      const parsed = parsePreview(await api.post<unknown>(path, body));
      if (version !== selectionVersion.current) return;
      if (!parsed) setProblem({ kind: 'message', text: REFUND_PURPOSE_COPY.previewFailed });
      else setPreview({ ...parsed, targetProjectId, roomId });
    } catch (error) {
      if (version !== selectionVersion.current) return;
      const actionable = error instanceof ApiResponseError && error.status === 400 && error.message;
      setProblem({ kind: 'message', text: actionable || REFUND_PURPOSE_COPY.previewFailed });
    } finally {
      setBusy(null);
    }
  }, [selection, path, setBusy]);

  const confirm = useCallback(async () => {
    if (busyRef.current || !preview) return;
    const attempt = preview;
    const body: RefundPurposeRequest = {
      mode: 'apply',
      targetProjectId: attempt.targetProjectId,
      roomId: attempt.roomId,
      expectedRevision: attempt.revision,
      expectedFingerprint: attempt.fingerprint,
    };
    setBusy('apply');
    setProblem(null);
    setNotice(null);
    setResult(null);
    try {
      const applied = parseApplied(await api.post<unknown>(path, body));
      setPreview(null);
      refreshViews(attempt.targetProjectId);
      if (!applied) {
        setNotice('lost-apply');
        setStale(true);
        return;
      }
      setResult(applied.alreadyApplied ? 'already-applied' : 'applied');
      void read.refetch();
    } catch (error) {
      setPreview(null);
      if (isUncertain(error)) {
        refreshViews(attempt.targetProjectId);
        setNotice('lost-apply');
        setStale(true);
      } else if (error instanceof ApiResponseError && error.status === 409) {
        setProblem({ kind: 'conflict' });
        setStale(true);
      } else {
        setProblem({ kind: 'message', text: REFUND_PURPOSE_COPY.applyFailed });
        setStale(true);
      }
    } finally {
      setBusy(null);
    }
  }, [preview, path, read, refreshViews, setBusy]);

  const undo = useCallback(async () => {
    const assignment = state?.assignment;
    if (busyRef.current || !assignment) return;
    const body: UndoRefundPurposeRequest = { expectedRevision: assignment.revision };
    const targetProjectId = assignment.summary.targetProjectId;
    setBusy('undo');
    setConfirmingUndo(false);
    setProblem(null);
    setNotice(null);
    setResult(null);
    try {
      const undone = parseUndone(await api.deleteWithBody<unknown>(path, body));
      refreshViews(targetProjectId);
      if (!undone) {
        setNotice('lost-undo');
        setStale(true);
        return;
      }
      setResult(undone.alreadyUndone ? 'already-undone' : 'undone');
      void read.refetch();
    } catch (error) {
      if (isUncertain(error)) {
        refreshViews(targetProjectId);
        setNotice('lost-undo');
      } else if (error instanceof ApiResponseError && error.status === 409) {
        setProblem({ kind: 'conflict' });
      } else {
        setProblem({ kind: 'message', text: REFUND_PURPOSE_COPY.undoFailed });
      }
      setStale(true);
    } finally {
      setBusy(null);
    }
  }, [state, path, read, refreshViews, setBusy]);

  return {
    loading: authLoading || read.isFetching,
    readFailed: !authLoading && (userId === null || read.isError),
    state,
    stale,
    busy,
    canUndo,
    destinations,
    catalogFailed: catalog.isError,
    catalogLoading: catalog.isFetching && !catalog.data,
    reloadCatalog: () => void catalog.refetch(),
    selectedTarget,
    assignmentTarget,
    selection,
    selectProject,
    selectRoom,
    preview,
    confirmingUndo,
    setConfirmingUndo,
    notice,
    problem,
    result,
    reread,
    requestPreview,
    confirm,
    undo,
  };
}
