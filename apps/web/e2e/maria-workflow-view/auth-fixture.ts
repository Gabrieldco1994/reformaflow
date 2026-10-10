import { useSyncExternalStore } from "react";

export function useAuth() {
  const id = useSyncExternalStore(
    (listener) => {
      window.addEventListener("p08-actor", listener);
      return () => window.removeEventListener("p08-actor", listener);
    },
    () =>
      document.documentElement.dataset.offlineActor ?? "workflow-offline-actor",
  );
  return { user: { id } };
}
