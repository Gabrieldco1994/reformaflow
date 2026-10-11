import { Test } from "@nestjs/testing";
import { AgentService } from "./agent.service";
import { AgentToolsService } from "./tools/agent-tools.service";
import { LLM_PROVIDER } from "./llm/llm.types";
import { ImportSessionEntryService } from "../imports/import-session/import-session-entry.service";
import { PrismaService } from "../prisma/prisma.service";

describe("server-owned Maria CSV entry action", () => {
  const prisma = new PrismaService();
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    await prisma.$connect();
  });
  afterAll(async () => prisma.$disconnect());
  const finance = () =>
    Promise.all([
      prisma.expense.count({ where: { tenantId: "tenant-entry" } }),
      prisma.cashFlowEntry.count({ where: { tenantId: "tenant-entry" } }),
      prisma.receipt.count({ where: { tenantId: "tenant-entry" } }),
      prisma.rateioAllocation.count({ where: { tenantId: "tenant-entry" } }),
      prisma.crossProjectSettlement.count({
        where: { tenantId: "tenant-entry" },
      }),
    ]);
  const make = async (
    formats: readonly ("CSV" | "PDF")[] = ["CSV", "PDF"],
    available = true,
  ) => {
    const entry = new ImportSessionEntryService(
      {
        writesEnabled: () => false,
        newImportFormats: () => formats,
      },
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
    const tools = {
      getToolDefs: () => [],
      buildPrimer: async () => "",
      execute: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        AgentService,
        { provide: LLM_PROVIDER, useValue: llm },
        {
          provide: AgentToolsService,
          useValue: tools,
        },
        { provide: ImportSessionEntryService, useValue: entry },
      ],
    }).compile();
    return { module, llm, tools, service: module.get(AgentService) };
  };

  it.each(["TEXT", "VOICE"] as const)(
    "emits START_CARD_INVOICE_IMPORT with the authoritative %s origin and no LLM/tool call",
    async (origin) => {
      const { module, llm, tools, service } = await make();
      try {
        const beforeFinance = await finance();
        const result = await service.chat({
          tenantId: "tenant-entry",
          userId: "user-entry",
          originChannel: origin,
          messages: [{ role: "user", content: "Quero importar minha fatura" }],
        } as Parameters<AgentService["chat"]>[0] & {
          originChannel: typeof origin;
        });
        expect(result.importEntryAction).toEqual({
          version: 1,
          kind: "START_CARD_INVOICE_IMPORT",
          formats: ["CSV", "PDF"],
          suggestedCardId: null,
          originChannel: origin,
        });
        expect(result.provider).toBe("import-session");
        expect(result.reply).toContain("CSV");
        expect(result.reply).toContain("PDF");
        expect(result.toolsUsed).toEqual([]);
        expect(llm.chat).not.toHaveBeenCalled();
        expect(tools.execute).not.toHaveBeenCalled();
        expect(await finance()).toEqual(beforeFinance);
      } finally {
        await module.close();
      }
    },
  );

  it.each([
    [["CSV"] as const, "CSV"],
    [["PDF"] as const, "PDF"],
  ])(
    "derives pre-session copy from the authoritative %s enabled formats",
    async (formats, expectedFormat) => {
      const { module, service } = await make(formats);
      try {
        const result = await service.chat({
          tenantId: "tenant-entry",
          messages: [{ role: "user", content: "Importar fatura" }],
        });
        expect(result.reply).toContain(expectedFormat);
        for (const disabledFormat of ["CSV", "PDF"].filter(
          (format) => !formats.some((enabled) => enabled === format),
        )) {
          expect(result.reply).not.toContain(disabledFormat);
        }
      } finally {
        await module.close();
      }
    },
  );

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
    const { module, llm, service } = await make(["CSV", "PDF"], false);
    try {
      const result = await service.chat({
        tenantId: "tenant-entry",
        messages: [{ role: "user", content: "Importar fatura" }],
      });
      expect(result.importEntryAction).toEqual({
        version: 1,
        kind: "IMPORT_UNAVAILABLE",
        originChannel: "TEXT",
      });
      expect(llm.chat).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
});
