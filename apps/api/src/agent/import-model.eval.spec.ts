import { randomUUID } from "node:crypto";
import {
  ImportSessionState,
  ImportSessionAmountMeaning,
  LaborCategory,
  type ImportChatTurnV1,
  ExpenseType,
  type ImportSessionDraftQuestionV1,
} from "@reformaflow/domain";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.provider";
import { type ImportModelRead } from "./import-chat.contract";
import {
  importAnswerMessages,
  importAnswerToolDefinitions,
} from "./import-chat.prompt";
import { resolveImportAnswer } from "../imports/import-session/import-chat-answer";
import { validateSyntheticCallBatch } from "./import-model.eval-validation";

// Explicit synthetic, loopback-only evaluation; never run against hosted providers.
const evaluate =
  process.env.MARIA_SYNTHETIC_MODEL_EVAL === "1" ? describe : describe.skip;
evaluate("synthetic Ollama import contract evaluation", () => {
  const cases: {
    field: ImportSessionDraftQuestionV1["field"];
    literal: string;
    value?: unknown;
    clarify?: boolean;
  }[] = [
    {
      field: "amountMeaning" as const,
      literal: "total da compra",
      value: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    },
    {
      field: "amountMeaning",
      literal: "valor da parcela",
      value: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
    },
    { field: "installmentCount", literal: "1", value: 1 },
    { field: "firstDueDate", literal: "10/11/2026", value: "2026-11-10" },
    { field: "targets", literal: "sem rateio", value: { kind: "NO_TARGETS" } },
    {
      field: "decision",
      literal: "criar compra nova",
      value: { kind: "CREATE", acceptNaturalDuplicate: false },
    },
    { field: "tipoDespesa", literal: "OUTROS", value: ExpenseType.OUTROS },
    {
      field: "amountMeaning",
      literal: "total ou parcela, não sei",
      clarify: true,
    },
  ];
  it.each(cases)(
    "$field: $literal",
    async ({ field, literal, value, clarify }) => {
      const provider = new OpenAiCompatibleProvider(
        "ollama",
        process.env.MARIA_SYNTHETIC_MODEL || "qwen2.5:7b",
      );
      const turn: ImportChatTurnV1 = {
        version: 1,
        turnId: randomUUID(),
        sessionId: "synthetic-session",
        expectedRevision: 7,
        channel: "TEXT",
        literalAnswer: literal,
        intent: "ANSWER",
        focus: { id: "synthetic-question", field, lineIds: ["synthetic-line"] },
        scope: { kind: "LINES", lineIds: ["synthetic-line"] },
      };
      const session: ImportModelRead = {
        version: 1,
        kind: "SESSION",
        state: ImportSessionState.NEEDS_INPUT,
        revision: 7,
        focus: {
          id: "synthetic-question",
          field,
          lineIds: ["synthetic-line"],
          text: `Informe ${field}.`,
        },
        lines: [
          {
            id: "synthetic-line",
            titulo: "Mercado sintético",
            amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
            amountCents: 12500,
            installmentCount: null,
            dataCompra: "2026-10-01",
            firstDueDate: null,
            targets: null,
            decision: { kind: "UNRESOLVED" },
            tipoDespesa: null,
            categoriaMaoDeObra: null,
          },
        ],
      };
      const messages = importAnswerMessages(turn.literalAnswer, session);
      const definitions = importAnswerToolDefinitions(turn);
      const originalLines = [
        {
          ...session.lines[0],
          observationIds: ["synthetic-observation"],
          fornecedor: null,
        },
      ];
      const before = structuredClone(originalLines);
      const nativeFetch = globalThis.fetch;
      const spy = jest
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url, init) => {
          expect(String(url)).toBe(
            "http://127.0.0.1:11434/v1/chat/completions",
          );
          const response = await nativeFetch(url, init);
          console.log("SYNTHETIC_MODEL_RAW", await response.clone().text());
          return response;
        });
      try {
        for (let iteration = 0; iteration < 4; iteration++) {
          const result = await provider.chat(messages, definitions, {
            responseContract: "IMPORT_CHAT_V1",
          });
          // Validate EVERY call before processing any result, just like production.
          const batch = validateSyntheticCallBatch(
            result.toolCalls,
            definitions,
          );
          messages.push({
            role: "assistant",
            content: result.content,
            toolCalls: result.toolCalls,
          });
          for (const { call, parsed } of batch) {
            console.log(
              "SYNTHETIC_TOOL",
              call.name,
              JSON.stringify(call.arguments),
            );
            if (parsed.name === "import_edit_answer") {
              const interpretation = parsed.arguments.interpretation;
              const resolved = resolveImportAnswer(
                literal,
                field,
                JSON.parse(JSON.stringify(interpretation)),
                originalLines,
              );
              expect(originalLines).toEqual(before);
              expect(resolved.kind).toBe(clarify ? "CLARIFY" : "VALUE");
              if (!clarify) {
                expect(interpretation).toMatchObject({
                  kind: "VALUE",
                  field,
                  value,
                });
                if (resolved.kind !== "VALUE")
                  throw new Error("Expected resolved value");
                const draftValue = field === "targets" ? [] : value;
                // Exact line comparison proves all non-target fields, money,
                // identity and provenance remain unchanged.
                expect(resolved.lines).toEqual(
                  before.map((line) => ({
                    ...line,
                    [field]: draftValue,
                  })),
                );
                expect(resolved.lines.map((line) => line.amountCents)).toEqual([
                  12500,
                ]);
              }
              return;
            }
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: JSON.stringify(
                call.name === "import_read_session"
                  ? session
                  : call.name === "import_read_observations"
                    ? {
                        version: 1,
                        kind: "OBSERVATIONS",
                        pageIndex: 0,
                        items: [],
                        hasMore: false,
                      }
                    : call.name === "list_payment_methods"
                      ? {
                          version: 1,
                          kind: "PAYMENT_METHODS",
                          card: {
                            id: "synthetic-card",
                            nickname: "Synthetic card",
                            institution: null,
                            last4: "4242",
                          },
                        }
                      : call.name === "get_category_taxonomy"
                        ? {
                            version: 1,
                            kind: "TAXONOMY",
                            expenseTypes: [
                              {
                                value: ExpenseType.OUTROS,
                                label: "Outros",
                                synonyms: [],
                              },
                            ],
                            laborCategories: Object.values(LaborCategory),
                          }
                        : (() => {
                            throw new Error(
                              `Unrepresented synthetic read: ${call.name}`,
                            );
                          })(),
              ),
            });
          }
        }
        throw new Error("No answer within synthetic budget");
      } finally {
        spy.mockRestore();
      }
    },
    120000,
  );
});
