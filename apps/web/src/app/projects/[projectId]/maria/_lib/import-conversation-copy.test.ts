import { expect, it } from "vitest";
import { ApiResponseError } from "@/lib/api";
import {
  importConversationFailure,
  importReceiptSpeech,
} from "./import-conversation-copy";
import { appliedFixture } from "./import-workflow-fixtures";

it.each([401, 403, 404, 409, 429, 500, 503])(
  "never echoes HTTP %s prose",
  (status) => {
    const failure = importConversationFailure(
      new ApiResponseError("SECRET Já lancei tudo", status, {
        reply: "SECRET",
      }),
    );
    expect(failure.message).not.toMatch(/SECRET|Já lancei/);
    expect(failure.privateContextLost).toBe([401, 403, 404].includes(status));
  },
);
it("receipt speech uses only a validated snapshot, never READ_RESULT alone", () => {
  expect(importReceiptSpeech({ state: "READY", receipt: null })).toBeNull();
  const applied = appliedFixture();
  expect(
    importReceiptSpeech({ state: "APPLIED", receipt: applied.receipt }),
  ).toContain("R$");
  const bad = appliedFixture();
  bad.receipt!.items.pop();
  expect(() =>
    importReceiptSpeech({ state: "APPLIED", receipt: bad.receipt }),
  ).toThrow();
});
