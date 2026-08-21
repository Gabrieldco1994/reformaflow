import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardas de leitura-de-arquivo sobre `globals.css`.
 *
 * Por que aqui e não em e2e: o Chromium do Playwright resolve
 * `env(safe-area-inset-*)` como 0 e (por padrão) não emula
 * `prefers-reduced-motion`. Uma asserção de runtime seria teatro — estas são
 * guardas contra **remoção** de regras estruturais (safe-area do dock, reset de
 * animação no shell). A prova de comportamento real é da lane de aparelho/QA.
 */
const css = readFileSync(join(__dirname, "globals.css"), "utf8");

describe("globals.css — guardas do shell mobile", () => {
  it("[U2-S01] a regra do dock referencia env(safe-area-inset-bottom)", () => {
    // guarda contra remoção — o notch não é asseverável em CI (E-6)
    expect(css).toMatch(/\.minimal-dock[^}]*env\(safe-area-inset-bottom\)/);
  });

  it("[D9] reduced-motion cobre as três superfícies do shell, não só o voice-orb", () => {
    // isola o(s) bloco(s) @media (prefers-reduced-motion: reduce) { ... }
    const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
      .map((m) => m[1])
      .join("\n");
    expect(blocks).toMatch(/\[data-dock\]/);
    expect(blocks).toMatch(/\[data-overlay\]/);
    expect(blocks).toMatch(/\[data-mobile-header\]/);
  });
});
