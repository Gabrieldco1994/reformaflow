import {
  buildFocusedInterpretation,
  IMPORT_INTERPRETATION_TOOL_DEF,
  parseInterpretationToolResult,
} from "./import-session-interpretation";
import { OpenAiCompatibleProvider } from "../../agent/llm/openai-compatible.provider";

describe("focused interpretation security boundary", () => {
  it("sends only a focused literal, semantic constraints and a request-local alias", () => {
    const first = buildFocusedInterpretation(
      "amountCents",
      "R$ 100,01",
      "focus_test_a",
    );
    const second = buildFocusedInterpretation(
      "amountCents",
      "R$ 100,01",
      "focus_test_b",
    );
    expect(Object.keys(first).sort()).toEqual([
      "constraints",
      "focusAlias",
      "literal",
      "semantic",
      "version",
    ]);
    expect(first.focusAlias).not.toBe(second.focusAlias);
    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "session-uuid",
      "line-uuid",
      "question-uuid",
      "1234",
      "arquivo.csv",
      "neighbor merchant",
      "proposalHash",
      "grant",
      "nonce",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("accepts exactly one non-writing tool result and exact evidence", () => {
    const focused = buildFocusedInterpretation(
      "amountCents",
      "paguei R$ 100,01 hoje",
      "focus_test",
    );
    expect(
      parseInterpretationToolResult(focused, [
        {
          id: "call-1",
          name: "submit_import_interpretation",
          arguments: {
            version: 1,
            focusAlias: "focus_test",
            evidence: { start: 7, end: 16, text: "R$ 100,01" },
            outcome: "CANDIDATE",
            candidate: { kind: "KNOWN", literal: "R$ 100,01" },
          },
        },
      ]),
    ).toEqual({ kind: "KNOWN", value: 10001 });
    expect(() =>
      parseInterpretationToolResult(focused, [
        {
          id: "call-1",
          name: "confirm_financial_write",
          arguments: {},
        },
      ]),
    ).toThrow();
    expect(() =>
      parseInterpretationToolResult(focused, [
        {
          id: "call-2",
          name: "submit_import_interpretation",
          arguments: {
            version: 1,
            focusAlias: "focus_test",
            evidence: { start: 7, end: 16, text: "R$ 100,01" },
            outcome: "CANDIDATE",
            candidate: { kind: "KNOWN", literal: "R$ 999,99" },
          },
        },
      ]),
    ).toThrow();
  });

  it("distinguishes exact clarification from missing or multiple tool output", () => {
    const focused = buildFocusedInterpretation(
      "dataCompra",
      "não lembro",
      "focus_clarify",
    );
    const clarification = {
      id: "call-clarify",
      name: "submit_import_interpretation",
      arguments: {
        version: 1,
        focusAlias: "focus_clarify",
        evidence: { start: 0, end: 10, text: "não lembro" },
        outcome: "CLARIFY",
        candidate: null,
      },
    };
    expect(parseInterpretationToolResult(focused, [clarification])).toBeNull();
    expect(() => parseInterpretationToolResult(focused, [])).toThrow();
    expect(() =>
      parseInterpretationToolResult(focused, [clarification, clarification]),
    ).toThrow();
  });

  it("forces the sole non-writing tool in one mocked provider call", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "submit_import_interpretation",
                      arguments: JSON.stringify({
                        version: 1,
                        focusAlias: "focus_test",
                        evidence: { start: 0, end: 1, text: "1" },
                        outcome: "CLARIFY",
                        candidate: null,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const provider = new OpenAiCompatibleProvider(
        "ollama",
        "synthetic-model",
      );
      await provider.chat(
        [{ role: "user", content: '{"literal":"1"}' }],
        [IMPORT_INTERPRETATION_TOOL_DEF],
        {
          responseContract: "IMPORT_INTERPRETATION_V1",
          requiredToolName: "submit_import_interpretation",
        },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      expect(body.tool_choice).toEqual({
        type: "function",
        function: { name: "submit_import_interpretation" },
      });
      expect(body.tools).toHaveLength(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
