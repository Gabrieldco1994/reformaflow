"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ProjectOption } from "../_types";

/**
 * Projetos administráveis para o seletor de alvo concreto ("Onde aparece" →
 * "Um projeto específico"). Reusa `GET /projects` (já usado em
 * `admin/users/page.tsx`) — nenhum endpoint de busca paralelo.
 */
export function useProjectOptions() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .get<ProjectOption[]>("/projects")
      .then((data) => {
        if (active) setProjects(data);
      })
      .catch(() => {
        if (active) setProjects([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { projects, loading };
}
