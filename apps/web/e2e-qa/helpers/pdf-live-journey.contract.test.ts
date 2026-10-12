import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import {
  sessionIdFromAnalyzeResponseUrl,
  waitForMariaImportEntry,
} from "./pdf-live-journey";
import {
  gotoValidatedMariaHref,
  waitForMariaEntryButton,
} from "./maria-entry-navigation";

const PDF_JOURNEY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "maria-pdf-textual.spec.ts",
);

type ExpectResult = {
  matches: boolean;
  received: { value: unknown };
  log: string[];
};

function locator(
  name: string,
  events: string[],
  href: string | null = null,
): Locator {
  return {
    _apiName: "Locator",
    _expect: async (
      expression: string,
      options: { expectedNumber?: number },
    ): Promise<ExpectResult> => {
      events.push(
        options.expectedNumber === undefined
          ? `assert:${name}:${expression}`
          : `assert:${name}:${expression}:${options.expectedNumber}`,
      );
      return {
        matches: true,
        received: { value: options.expectedNumber ?? true },
        log: [],
      };
    },
    getAttribute: async (attribute: string) => {
      events.push(`read:${name}:${attribute}`);
      return href;
    },
    toString: () => name,
  } as unknown as Locator;
}

function assertTypedAnalyzeSessionAdoption(source: string) {
  const start = source.indexOf(
    'const analyzeResponse = await evidence.response(\n      "textual-analysis"',
  );
  const end = source.indexOf("await page.reload()", start);
  assert.notEqual(start, -1, "typed analysis response must be captured");
  assert.notEqual(end, -1, "typed persistence reload must exist");
  const adoption = source.slice(start, end);

  assert.match(
    adoption,
    /const analyzeResponse = await evidence\.response\(/,
    "typed analysis must retain its matched successful response",
  );
  assert.match(
    adoption,
    /const sessionId = sessionIdFromAnalyzeResponseUrl\(analyzeResponse\.url\(\)\)/,
    "typed analysis must derive its session from the authoritative response URL",
  );
  assert.doesNotMatch(
    adoption,
    /sessionFromUrl\(page\)/,
    "typed analysis must not race asynchronous page URL adoption",
  );
  assert.match(
    adoption,
    /const persistentSessionHref = `\/projects\/\$\{journey\.projectId\}\/maria\?importSessionId=\$\{encodeURIComponent\(sessionId\)\}`/,
    "typed persistence must build the canonical project/session URL",
  );
  assert.match(
    adoption,
    /await page\.goto\(persistentSessionHref\)/,
    "typed persistence must adopt the canonical session URL before reload",
  );
}

test("extracts the authoritative session only from the exact analyze response path", () => {
  assert.equal(
    sessionIdFromAnalyzeResponseUrl(
      "http://api.test/import-sessions/session-123/attachments/attachment-456/analyze",
    ),
    "session-123",
  );
});

test("rejects malformed analyze response paths", () => {
  for (const url of [
    "not-a-url",
    "http://api.test/import-sessions//attachments/attachment-456/analyze",
    "http://api.test/import-sessions/session-123/attachments//analyze",
    "http://api.test/import-sessions/session-123/attachments/attachment-456",
    "http://api.test/import-sessions/session-123/attachments/attachment-456/analyze/extra",
    "http://api.test/prefix/import-sessions/session-123/attachments/attachment-456/analyze",
    "http://api.test/import-sessions/session%2Fother/attachments/attachment-456/analyze",
  ])
    assert.throws(
      () => sessionIdFromAnalyzeResponseUrl(url),
      /exact POST analyze response path/,
      url,
    );
});

test("successful typed analysis adopts the response session before persistence reload", () => {
  const source = readFileSync(PDF_JOURNEY_PATH, "utf8");
  assertTypedAnalyzeSessionAdoption(source);
  assert.throws(() =>
    assertTypedAnalyzeSessionAdoption(
      source.replace(
        "sessionIdFromAnalyzeResponseUrl(analyzeResponse.url())",
        "sessionFromUrl(page)",
      ),
    ),
  );
  assert.throws(() =>
    assertTypedAnalyzeSessionAdoption(
      source.replace("await page.goto(persistentSessionHref);", ""),
    ),
  );
});

test("mobile Maria destination is the exact validated project link href", async () => {
  const events: string[] = [];
  const expectedHref = "/projects/pessoal-1/maria";
  const maria = locator("maria-link", events, expectedHref);
  const page = {
    goto: async (href: string) => {
      events.push(`goto:${href}`);
      return null;
    },
  } as unknown as Page;

  await gotoValidatedMariaHref(page, maria, expectedHref);

  assert.deepEqual(events, [
    "assert:maria-link:to.have.attribute.value",
    "read:maria-link:href",
    `goto:${expectedHref}`,
  ]);
});

test("mobile Maria navigation rejects a different href before goto", async () => {
  const events: string[] = [];
  const maria = locator(
    "maria-link",
    events,
    "/projects/another-project/maria",
  );
  const page = {
    goto: async (href: string) => {
      events.push(`goto:${href}`);
      return null;
    },
  } as unknown as Page;

  await assert.rejects(
    gotoValidatedMariaHref(page, maria, "/projects/pessoal-1/maria"),
  );
  assert.equal(
    events.some((event) => event.startsWith("goto:")),
    false,
  );
});

test("exact Maria heading gate completes before the single exact CTA assertion", async () => {
  const events: string[] = [];
  const heading = locator("heading", events);
  const cta = locator("cta", events);
  const page = {
    getByRole: (
      role: string,
      options: { name: string; exact: boolean; level?: number },
    ) => {
      events.push(
        `locate:${role}:${options.name}:${options.exact}:${options.level ?? ""}`,
      );
      return role === "heading" ? heading : cta;
    },
  } as unknown as Page;

  assert.equal(await waitForMariaImportEntry(page), cta);
  assert.deepEqual(events, [
    "locate:heading:Maria:true:1",
    "assert:heading:to.be.visible",
    "locate:button:Importar fatura de cartão:true:",
    "assert:cta:to.have.count:1",
    "assert:cta:to.be.visible",
  ]);
});

test("exact Maria heading gate completes before the single exact voice CTA assertion", async () => {
  const events: string[] = [];
  const heading = locator("heading", events);
  const cta = locator("voice-cta", events);
  const page = {
    getByRole: (
      role: string,
      options: { name: string; exact: boolean; level?: number },
    ) => {
      events.push(
        `locate:${role}:${options.name}:${options.exact}:${options.level ?? ""}`,
      );
      return role === "heading" ? heading : cta;
    },
  } as unknown as Page;

  assert.equal(
    await waitForMariaEntryButton(page, "Iniciar conversa por voz"),
    cta,
  );
  assert.deepEqual(events, [
    "locate:heading:Maria:true:1",
    "assert:heading:to.be.visible",
    "locate:button:Iniciar conversa por voz:true:",
    "assert:voice-cta:to.have.count:1",
    "assert:voice-cta:to.be.visible",
  ]);
});
