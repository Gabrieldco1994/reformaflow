"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  ImportSessionCandidateV1,
  ImportSessionQuestionV1,
} from "@reformaflow/domain";
import { hasFeature, ProjectType } from "@reformaflow/domain";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { getImportCandidates } from "../_lib/import-session-api";
import { isRecord } from "../_lib/import-session-read";
import { importRoot } from "../_lib/import-session-keys";
import type { ImportTargetProjectOption } from "../_components/ImportFocusedDraftQuestion";

const named = (value: unknown): value is { id: string; name: string } =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  value.name.trim().length > 0;

const activeProject = (
  value: unknown,
): value is {
  id: string;
  name: string;
  type: string;
  deletedAt: null;
} =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  value.name.trim().length > 0 &&
  typeof value.type === "string" &&
  Object.hasOwn(value, "deletedAt") &&
  value.deletedAt === null;

async function readTargetProjects(
  ownerProjectId: string,
  hasProjectType: (type: string) => boolean,
  hasProjectAccess: (projectId: string) => boolean,
): Promise<ImportTargetProjectOption[]> {
  const list = await api.get<unknown>("/projects");
  if (!Array.isArray(list) || !list.every((project) => isRecord(project)))
    throw new Error("Import target catalog unavailable");
  const eligible = list.filter(
    (
      project,
    ): project is {
      id: string;
      name: string;
      type: typeof ProjectType.REFORMA;
      deletedAt: null;
    } =>
      activeProject(project) &&
      project.id !== ownerProjectId &&
      project.type === ProjectType.REFORMA &&
      hasFeature(ProjectType.REFORMA, "expenses") &&
      hasProjectType(project.type) &&
      hasProjectAccess(project.id),
  );
  return Promise.all(
    eligible.map(async (project) => {
      const detail = await api.get<unknown>(
        `/projects/${encodeURIComponent(project.id)}`,
      );
      if (
        !isRecord(detail) ||
        detail.id !== project.id ||
        detail.type !== ProjectType.REFORMA ||
        detail.deletedAt !== null ||
        !Array.isArray(detail.rooms)
      )
        throw new Error("Import target catalog unavailable");
      const rooms = detail.rooms.filter(
        (room): room is { id: string; name: string; deletedAt: null } =>
          isRecord(room) &&
          named(room) &&
          Object.hasOwn(room, "deletedAt") &&
          (room as Record<string, unknown>).deletedAt === null,
      );
      return {
        id: project.id,
        name: project.name,
        projectType: project.type,
        active: true,
        deletedAt: detail.deletedAt,
        eligible: true,
        rooms: rooms.map(({ id, name }) => ({ id, name })),
      };
    }),
  );
}

export function useImportManualOptions(
  userId: string | null,
  sessionId: string,
  ownerProjectId: string | null,
  question: ImportSessionQuestionV1 | null,
) {
  const { hasProjectType, hasProjectAccess } = useAuth();
  const decision = question?.field === "decision" && !("subject" in question);
  const targets = question?.field === "targets" && !("subject" in question);
  const candidates = useQuery({
    queryKey: [
      ...importRoot(userId ?? "anonymous"),
      "manual-candidates",
      sessionId,
      question?.id,
      question?.lineIds[0],
    ],
    enabled: Boolean(userId && decision && question?.lineIds.length === 1),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    networkMode: "always",
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<ImportSessionCandidateV1[]> => {
      if (!question || question.lineIds.length !== 1) return [];
      const items: ImportSessionCandidateV1[] = [];
      const seen = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        if (cursor !== null) {
          if (cursors.has(cursor))
            throw new Error("Repeated import candidate cursor");
          cursors.add(cursor);
        }
        const page = await getImportCandidates(
          sessionId,
          question.lineIds[0],
          cursor,
        );
        for (const candidate of page.items) {
          if (seen.has(candidate.id))
            throw new Error("Duplicate import candidate");
          seen.add(candidate.id);
          items.push(candidate);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      return items;
    },
  });
  const projects = useQuery({
    queryKey: [
      ...importRoot(userId ?? "anonymous"),
      "manual-target-projects",
      sessionId,
      ownerProjectId,
      question?.id,
    ],
    enabled: Boolean(userId && ownerProjectId && targets),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    networkMode: "always",
    refetchOnWindowFocus: false,
    queryFn: () => {
      if (!ownerProjectId) throw new Error("Import target catalog unavailable");
      return readTargetProjects(
        ownerProjectId,
        hasProjectType,
        hasProjectAccess,
      );
    },
  });
  const active = decision ? candidates : targets ? projects : null;
  return {
    candidates: decision ? (candidates.data ?? []) : [],
    projects: targets ? (projects.data ?? []) : [],
    ownerProjectId: targets ? ownerProjectId : null,
    pending: Boolean(active?.isFetching),
    error: active?.isError
      ? "Não foi possível consultar as opções autorizadas. Consulte novamente antes de guardar."
      : null,
    retry: active?.refetch,
  };
}
