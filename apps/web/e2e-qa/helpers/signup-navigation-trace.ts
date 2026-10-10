import type { Page } from "@playwright/test";

/** Read-only browser diagnostics. Never changes a route, auth state or UI state. */
export async function traceSignupNavigation(page: Page) {
  const events: unknown[] = [];
  const record = (event: unknown) => {
    if (events.length < 160) events.push({ at: Date.now(), event });
  };
  await page.exposeBinding("__qaSignupNavigation", (_source, event) =>
    record(event),
  );
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      record({
        kind: "frame",
        path: new URL(frame.url()).pathname,
      });
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (
      /^\/(auth\/(register|me)|projects(?:\/[^/]+(?:\/credit-cards)?)?|journeys\/.*)$/.test(
        path,
      )
    )
      record({
        kind: "response",
        path,
        method: response.request().method(),
        status: response.status(),
      });
  });
  await page.addInitScript(() => {
    let emitted = 0;
    const emit = (event: unknown) => {
      if (emitted++ >= 160) return;
      void (
        window as unknown as {
          __qaSignupNavigation: (event: unknown) => Promise<void>;
        }
      ).__qaSignupNavigation(event);
    };
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history);
      history[method] = (...args: Parameters<History["pushState"]>) => {
        const before = location.pathname;
        original(...args);
        emit({
          kind: method,
          before,
          path: location.pathname,
          stack: new Error().stack?.split("\n").slice(1, 7).join("\n"),
        });
      };
    }
    addEventListener("popstate", () =>
      emit({ kind: "popstate", path: location.pathname }),
    );
    let last = "";
    const snapshot = () => {
      const state = {
        kind: "render",
        path: location.pathname,
        headings: Array.from(document.querySelectorAll("h1,h2")).map(
          (el) => el.textContent,
        ),
        projectShell: document.body?.getAttribute("data-rf-shell") ?? null,
        mariaLink: Array.from(document.querySelectorAll("a")).some(
          (el) => el.textContent?.trim() === "Maria",
        ),
      };
      const stamp = JSON.stringify(state);
      if (stamp !== last) {
        last = stamp;
        emit(state);
      }
    };
    addEventListener(
      "DOMContentLoaded",
      () => {
        snapshot();
        new MutationObserver(snapshot).observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-rf-shell"],
        });
      },
      { once: true },
    );
  });
  return {
    events,
    mark: async (phase: string) => {
      record({ kind: "checkpoint", phase, path: new URL(page.url()).pathname });
    },
  };
}
