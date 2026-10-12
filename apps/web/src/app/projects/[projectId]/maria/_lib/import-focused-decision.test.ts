import { describe, expect, it } from "vitest";
import {
  sameFocusedValue,
  validFocusedDraftAnswer,
} from "./import-focused-draft";

describe("native choice admission is narrow and exact", () => {
  it("compares object keys structurally without coercion or reference equality", () => {
    expect(
      sameFocusedValue(
        { kind: "CREATE", acceptNaturalDuplicate: false },
        { acceptNaturalDuplicate: false, kind: "CREATE" },
      ),
    ).toBe(true);
    expect(sameFocusedValue([], [])).toBe(true);
    expect(sameFocusedValue(null, [])).toBe(false);
    expect(sameFocusedValue(false, "false")).toBe(false);
    expect(
      sameFocusedValue(
        { kind: "CREATE", acceptNaturalDuplicate: false },
        { kind: "CREATE", acceptNaturalDuplicate: false, extra: true },
      ),
    ).toBe(false);
  });
  it.each([
    {
      field: "decision",
      value: { kind: "CREATE", acceptNaturalDuplicate: false },
    },
    {
      field: "decision",
      value: { kind: "CREATE", acceptNaturalDuplicate: true },
    },
    {
      field: "decision",
      value: { kind: "KEEP_EXISTING", expenseId: "expense" },
    },
    { field: "targets", value: [] },
    {
      field: "targets",
      value: [{ projectId: "target", roomId: null, amountCents: 100 }],
    },
  ])("admits exact %j", (answer) => {
    expect(validFocusedDraftAnswer(answer)).toBe(true);
  });
  it.each([
    {
      field: "decision",
      value: { kind: "CREATE", acceptNaturalDuplicate: false, extra: true },
    },
    { field: "decision", value: { kind: "UNRESOLVED" } },
    { field: "decision", value: null },
    { field: "targets", value: null },
    { field: "targets", value: [{ projectId: "target", amountCents: 100 }] },
    { field: "targets", value: {} },
    { field: "targets", value: [], extra: true },
    { field: "decision", value: { kind: "CREATE" } },
  ])("rejects unsupported or structurally inexact %j", (answer) => {
    expect(validFocusedDraftAnswer(answer)).toBe(false);
  });
});
