"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { importKeys } from "../_lib/import-session-keys";
import { lookupNames, type NameLookup } from "../_lib/import-receipt-view";

const CATALOG_READ = {
  networkMode: "always",
  gcTime: 0,
  staleTime: 60_000,
  retry: false,
  refetchOnWindowFocus: false,
} as const;

/**
 * Names for the receipt come only from the catalog the user is already authorized to read.
 * A 403, a missing entry or an unexpected body degrade to generic labels; the catalog is
 * decoration, so its failure never blocks or fails the recovery screen.
 */
export function useImportCatalog(
  userId: string | null,
  enabled: boolean,
): { names: NameLookup; settled: boolean } {
  const active = enabled && userId !== null;
  const cards = useQuery<unknown>({
    ...CATALOG_READ,
    queryKey: importKeys.catalog(userId ?? "anonymous", "cards"),
    enabled: active,
    queryFn: () => api.get<unknown>("/tenant/credit-cards"),
  });
  const projects = useQuery<unknown>({
    ...CATALOG_READ,
    queryKey: importKeys.catalog(userId ?? "anonymous", "projects"),
    enabled: active,
    queryFn: () => api.get<unknown>("/projects"),
  });
  const names = useMemo(
    () =>
      lookupNames({
        cards: cards.data,
        projects: projects.data,
      }),
    [cards.data, projects.data],
  );
  const settled = active && !cards.isPending && !projects.isPending;
  return { names, settled };
}
