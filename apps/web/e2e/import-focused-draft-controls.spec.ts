import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertTouchable } from "../e2e-qa/helpers/evidence";

// Actual components and native controls, with local output capture only.
// No API mocking or live-import/financial-execution claim.
const root = path.resolve(__dirname, "..");
const component = path.join(
  root,
  "src/app/projects/[projectId]/maria/_components/ImportFocusedQuestion.tsx",
);
const viewportOwner = path.join(
  root,
  "src/app/projects/[projectId]/maria/_components/ImportQuestionViewportOwner.tsx",
);
let script: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { ImportFocusedQuestion } from ${JSON.stringify(component)};
        import { ImportQuestionViewportOwner } from ${JSON.stringify(viewportOwner)};
        import { ProjectProvider } from ${JSON.stringify(path.join(root, "src/contexts/project-context.tsx"))};
        const props = {
          lines: [{ id: "line", titulo: "Compra documental", amountCents: 20696 }],
          inputLabel: "Sua resposta", inputHint: "Confira",
          candidates: [{ lineId: "line", kind: "EXPENSE", id: "candidate-current", projectId: "project", description: "Compra já existente", amountCents: 20696, date: "2026-10-10", reason: "NATURAL_MATCH", canKeepExisting: true }],
          targetProjects: [{ id: "project-reforma", name: "Reforma autorizada", projectType: "REFORMA", eligible: true, active: true, deletedAt: null, rooms: [{ id: "room-reforma", name: "Cozinha" }] }],
          onAnswer: answer => {
            document.getElementById("output").textContent = JSON.stringify(answer);
          }
        };
        const root = createRoot(document.getElementById("root"));
        root.render(
          <ProjectProvider value={{projectId: "project", projectType: "REFORMA", projectName: "Reforma"}}>
            <main className="mx-auto flex h-screen w-full max-w-2xl min-w-0 flex-col">
              <ImportQuestionViewportOwner>
                <ImportFocusedQuestion {...props} question={{id: "q-meaning", field: "amountMeaning", lineIds: ["line"], text: "Significado"}} />
                <ImportFocusedQuestion {...props} question={{id: "q-amount", field: "amountCents", lineIds: ["line"], text: "Valor"}} />
                <ImportFocusedQuestion {...props} question={{id: "q-count", field: "installmentCount", lineIds: ["line"], text: "Parcelas"}} />
                <ImportFocusedQuestion {...props} question={{id: "q-purchase-date", field: "dataCompra", lineIds: ["line"], text: "Data da compra"}} />
                <ImportFocusedQuestion {...props} question={{id: "q-date", field: "firstDueDate", lineIds: ["line"], text: "Primeiro vencimento"}} />
                <ImportFocusedQuestion {...props} question={{id: "q-type", field: "tipoDespesa", lineIds: ["line"], text: "Tipo de despesa"}} />
                <ImportFocusedQuestion {...props} question={{id: "q-labor", field: "categoriaMaoDeObra", lineIds: ["line"], text: "Categoria de mão de obra"}} />
                <ImportFocusedQuestion {...props} question={{id: "q-create", field: "decision", lineIds: ["line"], text: "Criar compra"}} />
                <ImportFocusedQuestion {...props} question={{id: "q-targets", field: "targets", lineIds: ["line"], text: "Rateio"}} />
                <ImportFocusedQuestion
                  {...props}
                  question={{
                    id: "q-documentary",
                    field: "merchant",
                    lineIds: ["line"],
                    text: "Estabelecimento",
                    subject: {
                      kind: "OBSERVATION",
                      observationId: "observation",
                      meaningContext: null,
                    },
                    answerState: "UNANSWERED",
                  }}
                />
              </ImportQuestionViewportOwner>
            </main>
          </ProjectProvider>
        );
        window.unmountQuestionHarness = () => root.unmount();
      `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "focused-controls.js",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@": path.join(root, "src"),
      "@reformaflow/domain": path.resolve(
        root,
        "../../packages/domain/src/index.ts",
      ),
    },
    loader: { ".module.css": "local-css" },
  });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const moduleCss = bundle.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  )!.text;
  const content = await Promise.all(
    [
      component,
      path.join(path.dirname(component), "ImportFocusedDraftQuestion.tsx"),
      viewportOwner,
    ].map(async (file) => ({
      raw: await readFile(file, "utf8"),
      extension: "tsx",
    })),
  );
  content.push({
    raw: "mx-auto flex h-screen w-full max-w-2xl min-w-0 flex-col",
    extension: "tsx",
  });
  const compiled = await postcss([
    tailwindcss({
      ...require("../tailwind.config.js"),
      content,
    }),
  ]).process("@tailwind base; @tailwind components; @tailwind utilities;", {
    from: undefined,
  });
  css = compiled.css + moduleCss;
});
for (const width of [375, 390, 640, 1280]) {
  test(`native focused controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Match the real App Router layout; mobile otherwise uses a 980px layout viewport.
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><output id="output"></output>`,
    );
    expect(
      await page.evaluate(() => document.documentElement.clientWidth),
    ).toBe(width);
    await page.evaluate(() => {
      const viewport = new EventTarget() as VisualViewport;
      let viewportHeight = innerHeight;
      const listenerCounts = new Map<string, number>();
      const addEventListener = viewport.addEventListener.bind(viewport);
      const removeEventListener = viewport.removeEventListener.bind(viewport);
      viewport.addEventListener = ((type: string, listener: EventListener) => {
        listenerCounts.set(type, (listenerCounts.get(type) ?? 0) + 1);
        addEventListener(type, listener);
      }) as typeof viewport.addEventListener;
      viewport.removeEventListener = ((
        type: string,
        listener: EventListener,
      ) => {
        listenerCounts.set(
          type,
          Math.max(0, (listenerCounts.get(type) ?? 0) - 1),
        );
        removeEventListener(type, listener);
      }) as typeof viewport.removeEventListener;
      Object.defineProperties(viewport, {
        width: { get: () => innerWidth },
        height: {
          get: () => viewportHeight,
          set: (next: number) => {
            viewportHeight = next;
            viewport.dispatchEvent(new Event("resize"));
          },
        },
        offsetLeft: { value: 0 },
        offsetTop: { value: 0 },
        pageLeft: { get: () => scrollX },
        pageTop: { get: () => scrollY },
        scale: { value: 1 },
        activeListenerCount: {
          value: () =>
            (listenerCounts.get("resize") ?? 0) +
            (listenerCounts.get("scroll") ?? 0),
        },
      });
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: viewport,
      });
      const nativeRaf = requestAnimationFrame.bind(window);
      const nativeCancelRaf = cancelAnimationFrame.bind(window);
      const rafStats = { requested: 0, executed: 0, cancelled: 0 };
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        rafStats.requested++;
        return nativeRaf((time) => {
          rafStats.executed++;
          callback(time);
        });
      };
      window.cancelAnimationFrame = (handle: number) => {
        rafStats.cancelled++;
        nativeCancelRaf(handle);
      };
      Object.defineProperty(window, "questionViewportRafStats", {
        value: rafStats,
      });
    });
    await page.addScriptTag({ content: script });
    await expect(page.getByRole("form")).toHaveCount(10);
    await expect(
      page.getByRole("button", { name: "Responder à pergunta" }),
    ).toHaveCount(0);
    const waiverRadio = page.getByRole("radio", {
      name: "Criar outra compra — são compras distintas",
      exact: true,
    });
    const waiverLabel = waiverRadio.locator("xpath=ancestor::label");
    await assertTouchable(waiverLabel);
    await expect(waiverRadio).not.toBeChecked();
    await waiverLabel.click({ position: { x: 22, y: 22 } });
    await expect(waiverRadio).toBeChecked();
    const date = page.getByRole("textbox", {
      name: "Primeiro vencimento",
      exact: true,
    });
    await date.fill("2025-10-10");
    await expect(page.locator("#output")).toBeEmpty();
    const dateForm = page.locator("form").filter({ has: date });
    await dateForm.getByRole("button", { name: "Conferir informação" }).click();
    await expect(page.locator("#output")).toBeEmpty();
    await dateForm.getByRole("button", { name: "Guardar informação" }).click();
    await expect(page.locator("#output")).toHaveText(
      JSON.stringify({
        id: "q-date",
        text: "2025-10-10",
        draftAnswer: { field: "firstDueDate", value: "2025-10-10" },
      }),
    );
    const type = page.getByRole("combobox", {
      name: "Tipo de despesa",
      exact: true,
    });
    await type.selectOption("MAO_DE_OBRA");
    const typeForm = page.locator("form").filter({ has: type });
    await typeForm.getByRole("button", { name: "Conferir informação" }).click();
    await typeForm.getByRole("button", { name: "Guardar informação" }).click();
    await expect(page.locator("#output")).toHaveText(
      JSON.stringify({
        id: "q-type",
        text: "MAO_DE_OBRA",
        draftAnswer: { field: "tipoDespesa", value: "MAO_DE_OBRA" },
      }),
    );
    const waiverForm = page.locator("form").filter({ has: waiverRadio });
    await waiverForm
      .getByRole("button", { name: "Conferir informação" })
      .click();
    await waiverForm
      .getByRole("button", { name: "Guardar informação" })
      .click();
    await expect(page.locator("#output")).toHaveText(
      JSON.stringify({
        id: "q-create",
        text: "CREATE_ACCEPT_NATURAL_DUPLICATE",
        draftAnswer: {
          field: "decision",
          value: { kind: "CREATE", acceptNaturalDuplicate: true },
        },
      }),
    );
    for (const choice of [
      {
        label: "Sem rateio — manter no projeto proprietário",
        id: "q-targets",
        text: "NO_TARGETS",
        answer: { field: "targets", value: [] },
      },
    ]) {
      const radio = page.getByRole("radio", {
        name: choice.label,
        exact: true,
      });
      await expect(radio).not.toBeChecked();
      const form = page.locator("form").filter({ has: radio });
      await expect(
        form.getByRole("button", { name: "Guardar informação" }),
      ).toBeDisabled();
      await radio.check();
      await expect(
        form.getByRole("button", { name: "Guardar informação" }),
      ).toBeDisabled();
      await form.getByRole("button", { name: "Conferir informação" }).click();
      await expect(
        form.getByRole("list", { name: "Compras desta pergunta" }),
      ).toContainText("Compra documental");
      await form.getByRole("button", { name: "Guardar informação" }).click();
      await expect(page.locator("#output")).toHaveText(
        JSON.stringify({
          id: choice.id,
          text: choice.text,
          draftAnswer: choice.answer,
        }),
      );
    }
    for (const control of await page
      .locator("form button, form input, form select")
      .all()) {
      if (await control.isDisabled()) continue;
      if ((await control.getAttribute("type")) === "radio") {
        await assertTouchable(control.locator("xpath=ancestor::label"));
        continue;
      }
      await assertTouchable(control);
      await control.focus();
      await expect(control).toBeFocused();
    }
    const owner = page.locator('[data-import-question-viewport-owner="true"]');
    await expect(owner).toHaveCount(1);
    if (width < 640) {
      for (const controlName of [
        "Valor da compra",
        "Nome do estabelecimento",
      ]) {
        const control = page.getByRole("textbox", {
          name: controlName,
          exact: true,
        });
        const form = page.locator("form").filter({ has: control });
        await page.evaluate(() => {
          (window.visualViewport as unknown as { height: number }).height =
            innerHeight;
        });
        await page.waitForTimeout(30);
        await form.evaluate((element) =>
          element.scrollIntoView({ block: "start" }),
        );
        await control.focus();
        await page.waitForTimeout(30);
        const actions = form.locator("[data-import-question-actions]");
        const beforeKeyboard = await actions.evaluate((element) => ({
          actionBottom: element.getBoundingClientRect().bottom,
          ownerScrollTop: (
            element.closest(
              '[data-import-question-viewport-owner="true"]',
            ) as HTMLElement
          ).scrollTop,
        }));
        const viewportMutation = await page.evaluate(() => {
          const viewport = window.visualViewport!;
          (viewport as unknown as { height: number }).height = 240;
          return {
            height: window.visualViewport!.height,
            sameObject: window.visualViewport === viewport,
          };
        });
        expect(viewportMutation).toEqual({ height: 240, sameObject: true });
        await expect(control).toBeFocused();
        await expect
          .poll(() => owner.evaluate((element) => element.scrollTop))
          .toBeCloseTo(
            beforeKeyboard.ownerScrollTop +
              Math.max(0, beforeKeyboard.actionBottom - 240),
            0,
          );
        expect(
          await owner.evaluate(
            (element) =>
              (element.lastElementChild as HTMLElement).getBoundingClientRect()
                .height,
          ),
        ).toBe(660);
        for (const name of ["Conferir informação", "Guardar informação"]) {
          const action = form.getByRole("button", { name, exact: true });
          const measurement = await action.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const point = {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
            const hit = document.elementFromPoint(point.x, point.y);
            return {
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              visualViewportHeight: window.visualViewport!.height,
              hit: hit === element || element.contains(hit),
              position: getComputedStyle(element).position,
            };
          });
          expect(
            measurement.top,
            `${controlName}: ${name} above keyboard`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            measurement.bottom,
            `${controlName}: ${name} inside visual viewport`,
          ).toBeLessThanOrEqual(measurement.visualViewportHeight);
          expect(
            measurement.width,
            `${controlName}: ${name} touch width`,
          ).toBeGreaterThanOrEqual(44);
          expect(
            measurement.height,
            `${controlName}: ${name} touch height`,
          ).toBeGreaterThanOrEqual(44);
          expect(measurement.hit, `${controlName}: ${name} hit-testable`).toBe(
            true,
          );
          expect(
            measurement.position,
            `${controlName}: ${name} stays in normal flow`,
          ).toBe("static");
        }
        await expect(control).toBeFocused();
      }
      const stableScrollTop = await owner.evaluate(
        (element) => element.scrollTop,
      );
      const rafBefore = await page.evaluate(
        () =>
          (
            window as unknown as {
              questionViewportRafStats: { requested: number };
            }
          ).questionViewportRafStats.requested,
      );
      await page.evaluate(() => {
        for (let index = 0; index < 20; index++) {
          window.visualViewport!.dispatchEvent(new Event("resize"));
          window.visualViewport!.dispatchEvent(new Event("scroll"));
        }
      });
      await page.waitForTimeout(50);
      expect(await owner.evaluate((element) => element.scrollTop)).toBe(
        stableScrollTop,
      );
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                questionViewportRafStats: { requested: number };
              }
            ).questionViewportRafStats.requested,
        ),
      ).toBe(rafBefore + 1);
    } else {
      const amount = page.getByRole("textbox", {
        name: "Valor da compra",
        exact: true,
      });
      const amountForm = page.locator("form").filter({ has: amount });
      await amountForm.evaluate((element) =>
        element.scrollIntoView({ block: "start" }),
      );
      const scrollBeforeFocus = await owner.evaluate(
        (element) => element.scrollTop,
      );
      await amount.focus();
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        (viewport as unknown as { height: number }).height = 240;
        viewport.dispatchEvent(new Event("scroll"));
      });
      await page.waitForTimeout(50);
      await expect(amount).toBeFocused();
      expect(await owner.evaluate((element) => element.scrollTop)).toBe(
        scrollBeforeFocus,
      );
      for (const name of ["Conferir informação", "Guardar informação"]) {
        const action = amountForm.getByRole("button", { name, exact: true });
        const box = await action.boundingBox();
        expect(box, `${name} has a desktop layout box`).not.toBeNull();
        expect(
          box!.width,
          `${name} desktop touch width`,
        ).toBeGreaterThanOrEqual(44);
        expect(
          box!.height,
          `${name} desktop touch height`,
        ).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => window.visualViewport!.height)).toBe(
        240,
      );
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const activeListeners = await page.evaluate(() =>
      (
        window.visualViewport as VisualViewport & {
          activeListenerCount: () => number;
        }
      ).activeListenerCount(),
    );
    expect(activeListeners).toBe(2);
    await page.evaluate(() => {
      window.visualViewport!.dispatchEvent(new Event("resize"));
      (
        window as unknown as { unmountQuestionHarness: () => void }
      ).unmountQuestionHarness();
    });
    await expect(owner).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (
          window.visualViewport as VisualViewport & {
            activeListenerCount: () => number;
          }
        ).activeListenerCount(),
      ),
    ).toBe(0);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              questionViewportRafStats: { cancelled: number };
            }
          ).questionViewportRafStats.cancelled,
      ),
    ).toBeGreaterThan(0);
  });
}
