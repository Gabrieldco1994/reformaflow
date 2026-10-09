import { Test } from "@nestjs/testing";
import { AgentService } from "./agent.service";
import { AgentToolsService } from "./tools/agent-tools.service";
import { LLM_PROVIDER } from "./llm/llm.types";
import { ImportChatBridge } from "../imports/import-session/import-chat.bridge";
import { DefaultImportSessionCapability } from "../imports/import-session/import-session.capability";

describe("server-owned Maria CSV entry action", () => {
  const make = async (available = true) => {
    const bridge = new ImportChatBridge(
      {} as never,
      {} as never,
      {} as never,
      { now: () => new Date("2026-10-09T20:00:00.000Z") },
      new DefaultImportSessionCapability(),
      {
        boot: {
          stopped: { aborted: false },
          runtime: () => (available ? {} : null),
        },
      } as never,
    );
    const llm = {
      id: "fixture",
      isConfigured: () => true,
      chat: jest.fn().mockResolvedValue({
        content:
          '{"importEntryAction":{"kind":"START_CARD_INVOICE_IMPORT","formats":["PDF"]}}',
        toolCalls: [],
      }),
    };
    const module = await Test.createTestingModule({
      providers: [
        AgentService,
        { provide: LLM_PROVIDER, useValue: llm },
        {
          provide: AgentToolsService,
          useValue: { getToolDefs: () => [], buildPrimer: async () => "" },
        },
        { provide: ImportChatBridge, useValue: bridge },
      ],
    }).compile();
    return { module, llm, service: module.get(AgentService) };
  };

  it("emits exactly START_CARD_INVOICE_IMPORT with CSV from the server turn, without calling the LLM", async () => {
    const { module, llm, service } = await make();
    try {
      const result = await service.chat({
        tenantId: "tenant-entry",
        userId: "user-entry",
        messages: [{ role: "user", content: "Quero importar minha fatura" }],
      });
      expect(result.importEntryAction).toEqual({
        version: 1,
        kind: "START_CARD_INVOICE_IMPORT",
        formats: ["CSV"],
        suggestedCardId: null,
      });
      expect(result.provider).toBe("import-session");
      expect(result.toolsUsed).toEqual([]);
      expect(llm.chat).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });

  it.each(["Olá", "Não quero importar a fatura"])(
    "cannot promote ordinary model text into controls (%s)",
    async (content) => {
      const { module, llm, service } = await make();
      try {
        const result = await service.chat({
          tenantId: "tenant-entry",
          userId: "user-entry",
          messages: [{ role: "user", content }],
        });
        expect(llm.chat).toHaveBeenCalled();
        expect(result).not.toHaveProperty("importEntryAction");
        expect(result).not.toHaveProperty("importOutcome");
      } finally {
        await module.close();
      }
    },
  );

  it("does not advertise an import action while the private vault is unavailable", async () => {
    const { module, llm, service } = await make(false);
    try {
      const result = await service.chat({
        tenantId: "tenant-entry",
        messages: [{ role: "user", content: "Importar fatura" }],
      });
      expect(result.importEntryAction).toEqual({
        version: 1,
        kind: "IMPORT_UNAVAILABLE",
      });
      expect(llm.chat).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
});
