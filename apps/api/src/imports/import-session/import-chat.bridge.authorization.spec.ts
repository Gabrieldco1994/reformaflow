import type { ExecutionContext } from "@nestjs/common";
import {
  ImportSessionAmountMeaning,
  ImportSessionErrorCode,
  ImportSessionState,
  type ImportChatTurnV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { ImportChatBridge } from "./import-chat.bridge";
import {
  activateImportChat,
  registerPendingImportChat,
  releaseImportChat,
} from "./import-chat.admission";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "./import-session.auth";
import { DefaultImportSessionCapability } from "./import-session.capability";
import { ImportSessionError, importSessionWire } from "./import-session.errors";
import type { ImportSessionService } from "./import-session.service";
import type { ImportSessionWorkflowService } from "./import-session-workflow.service";
import type { PrismaService } from "../../prisma/prisma.service";

describe("ImportChatBridge deterministic card authorization", () => {
  const now = new Date("2026-10-11T16:00:00.000Z");
  const tenantId = "tenant-current-opaque";
  const projectId = "project-current-opaque";
  const userId = "user-current-opaque";
  const cards = [
    {
      id: "card-authorized-opaque",
      tenantId,
      projectId,
      deletedAt: null,
      nickname: "Controle sintético",
      institution: null,
      last4: "9182",
    },
    {
      id: "card-foreign-opaque",
      tenantId: "tenant-foreign-opaque",
      projectId,
      deletedAt: null,
      nickname: "Foreign hidden",
      institution: null,
      last4: "1111",
    },
    {
      id: "card-unlisted-opaque",
      tenantId,
      projectId: "project-unlisted-opaque",
      deletedAt: null,
      nickname: "Unlisted hidden",
      institution: null,
      last4: "2222",
    },
    {
      id: "card-deleted-opaque",
      tenantId,
      projectId,
      deletedAt: new Date("2026-10-01T00:00:00.000Z"),
      nickname: "Deleted hidden",
      institution: null,
      last4: "3333",
    },
  ];
  const user = {
    id: userId,
    tenantId,
    deletedAt: null,
    sessionVersion: 0,
    role: "OWNER",
    isGuest: false,
    allowedModules: "[]",
    allowedProjects: "[]",
    allowedProjectTypes: "[]",
    tenant: { deletedAt: null, expiresAt: null },
  };
  const persistentBoundaries = {
    prepareInTx: jest.fn(() => {
      throw new Error("prepareInTx must never execute");
    }),
    applyInTx: jest.fn(() => {
      throw new Error("applyInTx must never execute");
    }),
  };

  function view(cardId: string): ImportSessionViewV1 {
    return {
      version: 1,
      id: "11111111-1111-4111-8111-111111111111",
      ownerProjectId: projectId,
      cardId,
      state: ImportSessionState.NEEDS_INPUT,
      revision: 3,
      expiresAt: "2026-10-17T16:00:00.000Z",
      lines: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          observationIds: ["44444444-4444-4444-8444-444444444444"],
          titulo: "Compra sintética",
          fornecedor: null,
          tipoDespesa: null,
          categoriaMaoDeObra: null,
          amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
          amountCents: 4400,
          installmentCount: null,
          dataCompra: "2026-10-01",
          firstDueDate: null,
          targets: null,
          decision: { kind: "UNRESOLVED" },
        },
      ],
      selectedLineIds: ["22222222-2222-4222-8222-222222222222"],
      questions: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          field: "amountMeaning",
          lineIds: ["22222222-2222-4222-8222-222222222222"],
          text: "Qual é o significado do valor?",
        },
      ],
      attachments: [],
      declaredFacts: [],
      reviewBlockers: [],
      searchComplete: false,
      proposal: null,
      confirmation: null,
      receipt: null,
      actions: ["RESOLVE", "CANCEL", "READ_RESULT"],
    };
  }

  async function readCard(cardId: string) {
    const sessionView = view(cardId);
    const turn: ImportChatTurnV1 = {
      version: 1,
      turnId: "55555555-5555-4555-8555-555555555555",
      sessionId: sessionView.id,
      expectedRevision: sessionView.revision,
      channel: "TEXT",
      intent: "ANSWER",
      literalAnswer: "resposta sintética",
      focus: {
        id: "33333333-3333-4333-8333-333333333333",
        field: "amountMeaning",
        lineIds: ["22222222-2222-4222-8222-222222222222"],
      },
      scope: {
        kind: "LINES",
        lineIds: ["22222222-2222-4222-8222-222222222222"],
      },
    };
    const body = Object.freeze({ importTurn: turn });
    const request = {
      body,
      user: {
        id: userId,
        tenantId,
        authClaims: {
          sessionVersion: 0,
          expiresAtEpochSeconds: now.getTime() / 1000 + 86400,
        },
      },
    };
    new ImportAuthGuard().canActivate({
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext);
    const auth = readImportAuthForRequest(request);
    registerPendingImportChat(request, auth, turn);
    const admission = activateImportChat(request, now)!;
    const findFirst = jest.fn(
      async ({ where }: { where: Record<string, unknown> }) => {
        const match = cards.find(
          (card) =>
            card.id === where.id &&
            card.tenantId === where.tenantId &&
            card.projectId === where.projectId &&
            card.deletedAt === where.deletedAt,
        );
        return match
          ? {
              id: match.id,
              nickname: match.nickname,
              institution: match.institution,
              last4: match.last4,
            }
          : null;
      },
    );
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      creditCard: { findFirst },
    };
    const sessions = {
      getSession: jest.fn().mockResolvedValue(sessionView),
    };
    const workflow = {
      editConversationAnswer: jest.fn(),
      prepareConversation: jest.fn(),
      prepare: jest.fn(),
      confirm: jest.fn(),
      execute: jest.fn(),
    };
    const bridge = new ImportChatBridge(
      sessions as unknown as ImportSessionService,
      workflow as unknown as ImportSessionWorkflowService,
      prisma as unknown as PrismaService,
      { now: () => now },
      new DefaultImportSessionCapability(),
      {} as never,
    );
    try {
      return {
        result: await bridge.read(admission, { kind: "PAYMENT_METHODS" }),
        findFirst,
        sessions,
        workflow,
      };
    } finally {
      releaseImportChat(admission);
    }
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["foreign tenant", "card-foreign-opaque"],
    ["unlisted project", "card-unlisted-opaque"],
    ["soft deleted", "card-deleted-opaque"],
    ["random unknown", "card-random-opaque"],
  ])(
    "returns the same opaque NOT_FOUND for %s card",
    async (_label, cardId) => {
      try {
        await readCard(cardId);
        throw new Error("expected opaque rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ImportSessionError);
        expect(importSessionWire(error as ImportSessionError)).toEqual({
          code: ImportSessionErrorCode.NOT_FOUND,
          retryable: false,
          sessionId: null,
          currentRevision: null,
          reason: null,
        });
        expect(
          JSON.stringify(importSessionWire(error as ImportSessionError)),
        ).not.toContain(cardId);
        expect(persistentBoundaries.prepareInTx).not.toHaveBeenCalled();
        expect(persistentBoundaries.applyInTx).not.toHaveBeenCalled();
      }
    },
  );

  it("returns only the session-bound authorized card as a positive control", async () => {
    const { result, findFirst, sessions, workflow } = await readCard(
      "card-authorized-opaque",
    );
    expect(result).toEqual({
      version: 1,
      kind: "PAYMENT_METHODS",
      card: {
        id: "card-authorized-opaque",
        nickname: "Controle sintético",
        institution: null,
        last4: "9182",
      },
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "card-authorized-opaque",
        tenantId,
        projectId,
        deletedAt: null,
      },
      select: { id: true, nickname: true, institution: true, last4: true },
    });
    expect(sessions.getSession).toHaveBeenCalledTimes(2);
    for (const write of Object.values(workflow))
      expect(write).not.toHaveBeenCalled();
    expect(persistentBoundaries.prepareInTx).not.toHaveBeenCalled();
    expect(persistentBoundaries.applyInTx).not.toHaveBeenCalled();
  });
});
