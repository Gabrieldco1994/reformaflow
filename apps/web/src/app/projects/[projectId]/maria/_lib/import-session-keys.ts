export type ImportListScope = "active" | "applied";

/**
 * Every recovery query lives under a per-user namespace. The app never clears the
 * QueryClient on logout, so a key without the user id could show one person's receipt
 * to the next person who signs in on the same page session.
 */
export const importRoot = (userId: string) =>
  ["maria", "import", userId] as const;

export const importKeys = {
  entryCards: (userId: string) =>
    [...importRoot(userId), "entry-cards"] as const,
  list: (userId: string, scope: ImportListScope) =>
    [...importRoot(userId), "list", scope] as const,
  session: (userId: string, id: string) =>
    [...importRoot(userId), "session", id] as const,
  result: (userId: string, id: string) =>
    [...importRoot(userId), "result", id] as const,
  catalog: (userId: string, kind: "cards" | "projects") =>
    [...importRoot(userId), "catalog", kind] as const,
};
