import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "@playwright/test";
import {
  gotoValidatedMariaHref,
  waitForMariaImportEntry,
} from "./pdf-live-journey";

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
