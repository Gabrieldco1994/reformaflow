import { describe, expect, expectTypeOf, it } from "vitest";
import type { ImportChatTurnV1 } from "../src/import-conversation";
import type { ImportEntryActionV1 } from "../src/import-session";

type TransportOrigin = "TEXT" | "VOICE";
type StartAction = Extract<
  ImportEntryActionV1,
  { kind: "START_CARD_INVOICE_IMPORT" }
>;

describe("Maria generic/contextual transport contract", () => {
  it("keeps the same closed TEXT/VOICE vocabulary on generic START and contextual turns", () => {
    expectTypeOf<StartAction["origin"]>().toEqualTypeOf<TransportOrigin>();
    expectTypeOf<
      ImportChatTurnV1["channel"]
    >().toEqualTypeOf<TransportOrigin>();
    expect(["TEXT", "VOICE"]).toEqual(["TEXT", "VOICE"]);
  });

  it.each(["TEXT", "VOICE"] as const)(
    "carries %s on a typed START action",
    (origin) => {
      const action = {
        version: 1,
        kind: "START_CARD_INVOICE_IMPORT",
        formats: ["CSV"],
        suggestedCardId: null,
        origin,
      } satisfies ImportEntryActionV1;
      expect(action.origin).toBe(origin);
    },
  );
});
