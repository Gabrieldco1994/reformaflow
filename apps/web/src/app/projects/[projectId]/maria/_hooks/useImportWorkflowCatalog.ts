"use client";

import { useQuery } from "@tanstack/react-query";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { api } from "@/lib/api";
import { importRoot } from "../_lib/import-session-keys";
import { lookupNames } from "../_lib/import-receipt-view";
import { isRecord } from "../_lib/import-session-read";

const named = (v: unknown): v is { id: string; name: string } =>
  isRecord(v) &&
  typeof v.id === "string" &&
  typeof v.name === "string" &&
  v.name.trim().length > 0;

/** Unlike recovery decoration, unseen names must block a financial confirmation. */
async function readCatalog(view: ImportSessionViewV1, signal: AbortSignal) {
  const [projects, cards] = await Promise.all([
    api.get<unknown>("/projects"),
    api.get<unknown>("/tenant/credit-cards"),
  ]);
  signal.throwIfAborted();
  const unavailable = () => new Error("Import workflow catalog unavailable");
  if (
    !Array.isArray(projects) ||
    !projects.every(named) ||
    !Array.isArray(cards)
  )
    throw unavailable();
  const card = cards.find((v: unknown) => isRecord(v) && v.id === view.cardId);
  if (
    !isRecord(card) ||
    !named(card.project) ||
    card.project.id !== view.ownerProjectId ||
    !(
      (typeof card.nickname === "string" && card.nickname.trim()) ||
      (typeof card.last4 === "string" && /^\d{4}$/.test(card.last4))
    )
  )
    throw unavailable();
  const targets =
    view.proposal?.lines.flatMap((line) =>
      line.kind === "CREATE" ? line.targets : [],
    ) ?? [];
  const required = new Set([
    view.ownerProjectId,
    ...targets.map((t) => t.projectId),
    ...(view.receipt?.snapshot.participantProjectIds ?? []),
  ]);
  if ([...required].some((id) => !projects.some((p) => p.id === id)))
    throw unavailable();
  const rooms = new Map<string, string>();
  const roomProjects = [
    ...new Set(
      targets.filter((t) => t.roomId !== null).map((t) => t.projectId),
    ),
  ];
  await Promise.all(
    roomProjects.map(async (projectId) => {
      const detail = await api.get<unknown>(
        `/projects/${encodeURIComponent(projectId)}`,
      );
      signal.throwIfAborted();
      if (
        !isRecord(detail) ||
        detail.id !== projectId ||
        !Array.isArray(detail.rooms)
      )
        throw unavailable();
      for (const target of targets.filter(
        (t) => t.projectId === projectId && t.roomId !== null,
      )) {
        const room = detail.rooms.find(
          (r: unknown) => named(r) && r.id === target.roomId,
        );
        if (!named(room) || !("deletedAt" in room) || room.deletedAt !== null)
          throw unavailable();
        rooms.set(`${projectId}/${target.roomId}`, room.name);
      }
    }),
  );
  return { names: lookupNames({ projects, cards }), rooms };
}

export function useImportWorkflowCatalog(
  userId: string | null,
  view: ImportSessionViewV1 | null,
) {
  const enabled =
    userId !== null &&
    view !== null &&
    (view.proposal !== null || view.receipt !== null);
  const query = useQuery({
    queryKey: [
      ...importRoot(userId ?? "anonymous"),
      "workflow-catalog",
      view?.id,
      view?.revision,
      view?.proposal?.proposalHash,
    ],
    enabled,
    networkMode: "always",
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => {
      if (!view) throw new Error("Import workflow catalog requires a view");
      return readCatalog(view, signal);
    },
  });
  return {
    data:
      enabled && !query.isError && !query.isFetching
        ? (query.data ?? null)
        : null,
    pending: enabled && query.isFetching,
    error:
      enabled && query.isError
        ? "Não foi possível identificar o cartão, a origem e todas as finalidades. Consulte os nomes novamente antes de confirmar."
        : null,
    retry: query.refetch,
  };
}
