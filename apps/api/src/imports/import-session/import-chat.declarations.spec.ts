require("../../../../../scripts/test-db-env.cjs");
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import {
  ExpenseType,
  type ImportChatTurnV1,
  type ImportHumanFactFieldV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { AgentController } from "../../agent/agent.controller";
import { PrismaService } from "../../prisma/prisma.service";
import { ExpenseService } from "../../expense/expense.service";
import { reauthorize } from "./import-session.auth";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import * as dedupe from "../../credit-card/parsers/dedupe-key";
import * as crossOrigin from "../../import-dedupe/cross-origin-dedupe";
import * as cardIdentity from "../../credit-card/card-purchase-identity";
import {
  FIXED_NOW,
  authFor,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootRecoveryApp,
  UI_HEADERS,
  type RecoveryApp,
} from "../../test-utils/import-session-recovery-harness";
import {
  connectVaultTestDatabase,
  createVaultTestDatabase,
} from "../../test-utils/import-session-vault-harness";
import { buildImportMaterialization } from "./import-session.extraction";
import { parseStoredDraft } from "./import-session.projection";
import { ImportSessionCorruptStateError } from "./import-session.errors";
import { renderImportSession } from "./import-session.service";
import { ImportChatBridge } from "./import-chat.bridge";
import { ImportChatGuard } from "./import-chat.guard";
import type { ImportChatAdmission } from "./import-chat.admission";

describe("B3 real guard/bridge/writer with HTTP GET, PREPARE and confirmation", () => {
  let fixture: Awaited<ReturnType<typeof createVaultTestDatabase>>;
  let h: RecoveryApp;
  let world: ImportWorld;
  let sessionId: string;
  let token: string;
  let bridge: ImportChatBridge;
  let held: ImportChatAdmission | undefined;
  const route = (suffix = "") => `/import-sessions/${sessionId}${suffix}`;

  beforeAll(async () => {
    jest.useFakeTimers({
      now: FIXED_NOW,
      doNotFake: [
        "nextTick",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    fixture = await createVaultTestDatabase();
    h = await bootRecoveryApp(fixture.setup, {
      writesEnabled: true,
      beforeListen: async (app) => {
        await app.init();
        await connectVaultTestDatabase(app.get(PrismaService));
      },
    });
    bridge = h.app.get(ImportChatBridge);
  });
  beforeEach(async () => {
    jest.setSystemTime(FIXED_NOW);
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new Error("Provider/egress forbidden in B3 local test"),
      );
    h.clock.current = new Date(FIXED_NOW);
    world = await seedImportWorld(fixture.setup, `b3-be-${randomUUID()}`);
    await fixture.setup.creditCard.update({
      where: { id: world.cards.pessoal },
      data: { closingDay: 27, dueDay: 5 },
    });
    const session = await seedSession(fixture.setup, world);
    sessionId = session.id;
    token = await h.tokenFor(world.users.owner);
    const bytes = Buffer.from("date,title,amount\n2026-09-25,LOJA,100.00\n");
    const extraction = extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes,
    });
    expect(extraction.occurrences[0]).toMatchObject({
      identityOrdinal: 0,
      dateOnly: "2026-09-25",
      amountCents: 10000,
    });
    const scope = {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
    };
    const artifact = await fixture.setup.importArtifact.create({
      data: {
        ...scope,
        documentSha256: createHash("sha256").update(bytes).digest("hex"),
        verifiedBytes: bytes.length,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        parserVersion: extraction.parserVersion,
        extractionJson: JSON.stringify(extraction),
      },
    });
    const attachment = await fixture.setup.importSessionArtifact.create({
      data: {
        ...scope,
        sessionId,
        artifactId: artifact.id,
        position: 0,
        fileName: "synthetic.csv",
        declaredMime: "text/csv",
        declaredBytes: bytes.length,
        reservedBytes: bytes.length,
        state: "ATTACHED",
        verifiedAt: FIXED_NOW,
      },
    });
    const plan = buildImportMaterialization({
      session,
      attachment,
      artifact,
      extraction,
      observations: [],
      draft: {
        version: 1,
        lines: [],
        questions: [],
        selectedLineIds: [],
        scope: { observationIds: [], pendingAttachmentIds: [attachment.id] },
      },
      newIds: new Map(
        extraction.occurrences.map((item) => [
          item.reference,
          { observationId: randomUUID(), lineId: "purchase" },
        ]),
      ),
    });
    await fixture.setup.importObservation.createMany({
      data: plan.observations,
    });
    await fixture.setup.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(plan.draft) },
    });
    const line = {
      ...plan.draft.lines[0],
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 10000,
      installmentCount: 1,
      firstDueDate: "2026-11-05",
      targets: [],
      decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    };
    const edited = await h.call("PATCH", route("/draft"), {
      token,
      headers: UI_HEADERS,
      body: {
        expectedRevision: 1,
        questionId: null,
        replaceLines: [line],
        selectedLineIds: ["purchase"],
      },
    });
    expect(edited.status).toBe(200);
  });
  afterEach(() => {
    if (held) bridge.release(held);
    held = undefined;
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await h?.close();
    await fixture?.close();
    jest.useRealTimers();
  });
  async function get(): Promise<ImportSessionViewV1> {
    const reply = await h.call("GET", route(), { token });
    expect(reply.status).toBe(200);
    return reply.json;
  }
  async function admit(
    field: ImportHumanFactFieldV1,
    literal: string,
    attachmentScope = false,
    draftQuestion = false,
  ) {
    if (held) bridge.release(held);
    const view = await get();
    const question = view.questions.find(
      (item) => "subject" in item !== draftQuestion && item.field === field,
    );
    if (!question) throw new Error(`No actual documentary question ${field}`);
    const turn: ImportChatTurnV1 = {
      version: 1,
      turnId: randomUUID(),
      sessionId,
      expectedRevision: view.revision,
      channel: "TEXT",
      literalAnswer: literal,
      intent: "ANSWER",
      focus: {
        id: question.id,
        field: question.field,
        lineIds: question.lineIds,
      },
      scope: attachmentScope
        ? { kind: "ATTACHMENT", attachmentId: view.attachments[0].id }
        : { kind: "LINES", lineIds: question.lineIds },
    };
    const request = {
      method: "POST",
      url: "/agent/chat",
      originalUrl: "/agent/chat",
      route: { path: "/agent/chat" },
      headers: UI_HEADERS,
      body: {
        messages: [{ role: "user", content: literal }],
        importTurn: turn,
      },
      user: {
        id: world.users.owner.id,
        tenantId: world.tenantId,
        role: "OWNER",
        authClaims: {
          sessionVersion: world.users.owner.sessionVersion,
          expiresAtEpochSeconds: FIXED_NOW.getTime() / 1000 + 3600,
        },
      },
    };
    const context = new ExecutionContextHost(
      [request],
      AgentController,
      AgentController.prototype.chat,
    );
    expect(h.app.get(ImportChatGuard).canActivate(context)).toBe(true);
    const admission = bridge.contextForRequest(request);
    if (!admission) throw new Error("Real guard failed to mint live admission");
    held = admission;
    return { admission, view, question };
  }
  async function answer(field: ImportHumanFactFieldV1, literal: string) {
    const { admission } = await admit(field, literal);
    return bridge.editAnswer(admission, {
      kind: "VALUE",
      field,
      evidence: { start: 0, end: literal.length },
      value: field === "amountMeaning" ? "TOTAL_PURCHASE" : 24,
    });
  }
  const row = () =>
    fixture.setup.importSession.findUniqueOrThrow({ where: { id: sessionId } });

  it("B3 repair audit annotates corrupt render errors after authentication without exposing stored content", async () => {
    const logger = jest.spyOn(Logger.prototype, "error").mockImplementation();
    await fixture.setup.importSession.update({
      where: { id: sessionId },
      data: {
        draftJson: JSON.stringify({
          ...parseStoredDraft((await row()).draftJson),
          secret: "private-audit-marker",
        }),
      },
    });
    const before = await row();

    expect((await h.call("GET", route())).status).toBe(401);
    expect(logger).not.toHaveBeenCalled();
    const reply = await h.call("GET", route(), { token });
    expect(reply.status).toBe(500);
    expect(reply.json).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
    const messages = logger.mock.calls.flat().join("\n");
    expect(messages).toContain(
      `ImportSessionCorruptStateError sessionId=${sessionId} column=draft`,
    );
    expect(messages).not.toContain("private-audit-marker");
    expect(reply.text).not.toContain("private-audit-marker");
    expect(await row()).toEqual(before);
  });

  it("B3 repair audit preserves the original corruption error identity and stack", async () => {
    const failure = new ImportSessionCorruptStateError("evidence_json");
    const original = {
      name: failure.name,
      message: failure.message,
      stack: failure.stack,
    };
    jest
      .spyOn(fixture.setup.importSessionArtifact, "findMany")
      .mockRejectedValueOnce(failure);

    await expect(
      renderImportSession(fixture.setup, await row(), FIXED_NOW, {
        includeReceipt: false,
      }),
    ).rejects.toBe(failure);
    expect(failure.sessionId).toBe(sessionId);
    expect(failure.name).toBe(original.name);
    expect(failure.message).toBe(original.message);
    expect(failure.stack).toBe(original.stack);
  });

  it("B3 repair audit rethrows unrelated errors unchanged without adding an audit id", async () => {
    const failure = new Error("synthetic database read failure");
    const original = Object.getOwnPropertyDescriptors(failure);
    jest
      .spyOn(fixture.setup.importSessionArtifact, "findMany")
      .mockRejectedValueOnce(failure);

    await expect(
      renderImportSession(fixture.setup, await row(), FIXED_NOW, {
        includeReceipt: false,
      }),
    ).rejects.toBe(failure);
    expect(Object.getOwnPropertyDescriptors(failure)).toEqual(original);
    expect(failure).not.toHaveProperty("sessionId");
  });

  it("B3 repair legacy no-op preserves the question and all metadata until an effective value change", async () => {
    const draft = parseStoredDraft((await row()).draftJson);
    draft.questions = [
      {
        id: "legacy-money-question",
        field: "amountCents",
        lineIds: ["purchase"],
        text: "Qual o valor da compra?",
      },
    ];
    await fixture.setup.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
    const before = await row();
    const same = await admit("amountCents", "100,00", false, true);
    const interpretation = (literal: string) => ({
      kind: "VALUE",
      field: "amountCents",
      evidence: { start: 0, end: literal.length },
      value: { span: { start: 0, end: literal.length }, text: literal },
    });

    await expect(
      bridge.editAnswer(same.admission, interpretation("100,00")),
    ).resolves.toMatchObject({
      acknowledgment: "NO_CHANGE",
      ref: { sessionId, revision: before.revision },
    });
    expect(await row()).toEqual(before);
    expect(await get()).toEqual(same.view);
    expect(parseStoredDraft((await row()).draftJson)).not.toHaveProperty(
      "declarations",
    );

    const changed = await admit("amountCents", "101,00", false, true);
    await expect(
      bridge.editAnswer(changed.admission, interpretation("101,00")),
    ).resolves.toMatchObject({
      acknowledgment: "EDITED",
      ref: { sessionId, revision: before.revision + 1 },
    });
    const after = parseStoredDraft((await row()).draftJson);
    expect(after.lines[0].amountCents).toBe(10100);
    expect(after.questions).toEqual([]);
    expect(after).not.toHaveProperty("declarations");
  });

  it("B3 repair documentary provenance is an effective change even when the draft already has that value", async () => {
    const before = await row();
    const draft = parseStoredDraft(before.draftJson);
    expect(draft.lines[0].amountMeaning).toBe("TOTAL_PURCHASE");
    expect(draft).not.toHaveProperty("declarations");

    await expect(
      answer("amountMeaning", "total da compra"),
    ).resolves.toMatchObject({
      acknowledgment: "EDITED",
      ref: { sessionId, revision: before.revision + 1 },
    });
    const attested = await row();
    expect(parseStoredDraft(attested.draftJson).declarations?.items).toEqual([
      expect.objectContaining({
        field: "amountMeaning",
        value: "TOTAL_PURCHASE",
        attestedByUserId: world.users.owner.id,
      }),
    ]);
    await expect(
      answer("amountMeaning", "total da compra"),
    ).resolves.toMatchObject({
      acknowledgment: "NO_CHANGE",
      ref: { sessionId, revision: attested.revision },
    });
    expect(await row()).toEqual(attested);
  });

  it("an index above the effective count clarifies without changing persisted support", async () => {
    await answer("amountMeaning", "valor da parcela");
    await answer("installmentCount", "3");
    await answer("installmentIndex", "2");
    const before = await row();
    const original = await fixture.setup.importObservation.findMany({
      where: { tenantId: world.tenantId },
    });

    await expect(answer("installmentIndex", "4")).resolves.toMatchObject({
      kind: "CLARIFY",
      acknowledgment: "NONE",
      reason: "INVALID_VALUE",
      ref: { sessionId, revision: before.revision },
    });
    expect(await row()).toEqual(before);
    expect(
      await fixture.setup.importObservation.findMany({
        where: { tenantId: world.tenantId },
      }),
    ).toEqual(original);
    expect((await get()).declaredFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "installmentIndex",
          value: 2,
          status: "CURRENT",
        }),
      ]),
    );

    expect(await answer("installmentIndex", "3")).toMatchObject({
      kind: "REVISED_SESSION",
      acknowledgment: "EDITED",
    });
    expect((await row()).revision).toBe(before.revision + 1);
  });

  it("GET -> literal ANSWER -> GET -> HTTP PREPARE uses declarations, not model values", async () => {
    const natural = jest.spyOn(dedupe, "dedupeKeyNatural");
    const strong = jest.spyOn(dedupe, "dedupeKeyStrong");
    const enumerate = jest.spyOn(crossOrigin, "enumerateDedupeMatches");
    const inspect = jest.spyOn(cardIdentity, "inspectCardImportInTx");
    const original = await fixture.setup.importObservation.findMany({
      where: { tenantId: world.tenantId },
    });
    expect((await get()).declaredFacts).toEqual([]);
    expect(parseStoredDraft((await row()).draftJson)).not.toHaveProperty(
      "declarations",
    );
    expect(await answer("amountMeaning", "valor da parcela")).toMatchObject({
      kind: "REVISED_SESSION",
      acknowledgment: "EDITED",
    });
    expect(await answer("installmentCount", "1")).toMatchObject({
      acknowledgment: "EDITED",
    });
    const declared = await get();
    expect(declared.declaredFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "amountMeaning",
          value: "INSTALLMENT_CHARGE",
          origin: "USER_ATTESTATION",
        }),
        expect.objectContaining({
          field: "installmentCount",
          value: 1,
          origin: "USER_ATTESTATION",
        }),
      ]),
    );
    expect(declared.reviewBlockers).toEqual([
      {
        lineId: "purchase",
        code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
        resolution: "RESOLVED_BY_USER",
      },
    ]);
    const prepared = await h.call("POST", route("/prepare"), {
      token,
      headers: UI_HEADERS,
      body: { expectedRevision: declared.revision },
    });
    expect(prepared.status).toBe(200);
    expect(prepared.json).toMatchObject({
      state: "READY",
      searchComplete: true,
      actions: expect.arrayContaining(["CONFIRM"]),
    });
    const recipe = {
      tenantId: world.tenantId,
      projectId: world.projects.pessoal,
      date: new Date("2026-09-25T00:00:00.000Z"),
      merchant: "LOJA",
      amountCents: 10000,
      ordinal: 0,
    };
    expect(natural).toHaveBeenCalledWith(recipe);
    expect(strong).toHaveBeenCalledWith(expect.objectContaining(recipe));
    expect(enumerate).toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledWith(
      expect.anything(),
      world.tenantId,
      expect.objectContaining({
        cardId: world.cards.pessoal,
        projectId: world.projects.pessoal,
        merchant: "LOJA",
        total: 1,
      }),
      expect.any(Number),
    );
    expect(
      await fixture.setup.importObservation.findMany({
        where: { tenantId: world.tenantId },
      }),
    ).toEqual(original);
    writeFileSync(
      join(fixture.directory, "get-answer-get-prepare.json"),
      JSON.stringify({ declared, prepared: prepared.json }),
      { mode: 0o600 },
    );
  });
  it("same answer in READY keeps author, time, revision, expiry, preflight and prepare generation", async () => {
    await answer("amountMeaning", "valor da parcela");
    await answer("installmentCount", "1");
    const current = await get();
    expect(
      (
        await h.call("POST", route("/prepare"), {
          token,
          headers: UI_HEADERS,
          body: { expectedRevision: current.revision },
        })
      ).status,
    ).toBe(200);
    const before = await row();
    h.clock.current = new Date(FIXED_NOW.getTime() + 60_000);
    expect(await answer("installmentCount", "1")).toMatchObject({
      acknowledgment: "NO_CHANGE",
    });
    expect(await row()).toEqual(before);
  });
  it("candidate reader offers canonical KEEP using the same effective observation facts as PREPARE", async () => {
    const source = await fixture.setup.$transaction(async (tx) => {
      const actor = await reauthorize(
        tx,
        authFor(world.users.owner),
        h.clock.now(),
      );
      return h.app.get(ExpenseService).createPlannedCardPurchaseInTx(
        tx,
        world.tenantId,
        world.projects.pessoal,
        {
          titulo: "LOJA - Parcela 2/3",
          fornecedor: "LOJA",
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          categoriaMaoDeObra: null,
          dataCompra: "2026-09-25",
          totalCents: 20000,
          cardId: world.cards.pessoal,
          schedule: {
            version: 1,
            occurrences: [
              {
                index: 0,
                parcela: "2/3",
                valor: 10000,
                data: "2026-11-05",
                invoiceDueMonth: "2026-11",
              },
              {
                index: 1,
                parcela: "3/3",
                valor: 10000,
                data: "2026-12-05",
                invoiceDueMonth: "2026-12",
              },
            ],
          },
          evidence: {
            documentSha256: "c".repeat(64),
            reference: "synthetic-existing-source",
          },
          reason: "Synthetic existing documented source for B3 compatibility",
        },
        actor.userId,
        { ...actor, id: actor.userId },
      );
    });
    const initial = await get();
    expect(
      (
        await h.call("PATCH", route("/draft"), {
          token,
          headers: UI_HEADERS,
          body: {
            expectedRevision: initial.revision,
            questionId: null,
            replaceLines: [
              { ...initial.lines[0], amountCents: 20000, installmentCount: 3 },
            ],
            selectedLineIds: ["purchase"],
          },
        })
      ).status,
    ).toBe(200);
    await answer("amountMeaning", "valor da parcela");
    await answer("installmentCount", "3");
    await answer("installmentIndex", "2");
    const view = await get();
    const prepared = await h.call("POST", route("/prepare"), {
      token,
      headers: UI_HEADERS,
      body: { expectedRevision: view.revision },
    });
    expect(prepared.status).toBe(200);
    const candidates = await h.call(
      "GET",
      route("/candidates?lineId=purchase"),
      { token },
    );
    expect(candidates.status).toBe(200);
    expect(candidates.json.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: source.id, canKeepExisting: true }),
      ]),
    );
    const current = await get();
    const edited = await h.call("PATCH", route("/draft"), {
      token,
      headers: UI_HEADERS,
      body: {
        expectedRevision: current.revision,
        questionId: null,
        replaceLines: [
          {
            ...current.lines[0],
            decision: { kind: "KEEP_EXISTING", expenseId: source.id },
          },
        ],
        selectedLineIds: ["purchase"],
      },
    });
    expect(edited.status).toBe(200);
    const kept = await h.call("POST", route("/prepare"), {
      token,
      headers: UI_HEADERS,
      body: { expectedRevision: edited.json.revision },
    });
    expect(kept.status).toBe(200);
    expect(kept.json).toMatchObject({
      state: "READY",
      proposal: {
        lines: [
          expect.objectContaining({
            kind: "KEEP_EXISTING",
            sourceExpenseId: source.id,
          }),
        ],
      },
    });
    expect(kept.json.proposal.lines[0].schedule.occurrences[0]).toMatchObject({
      index: 0,
      parcela: "2/3",
    });
    expect(
      (
        await fixture.setup.expense.findUniqueOrThrow({
          where: { id: source.id },
        })
      ).documentedSchedule,
    ).toBe(source.documentedSchedule);
  });
  it("a single number inside a negation is not an attestation despite the model VALUE", async () => {
    const before = await row();
    const result = await answer("installmentCount", "não são 3");
    expect(result).toMatchObject({ kind: "CLARIFY", acknowledgment: "NONE" });
    expect(await row()).toEqual(before);
  });
  it("ordinary draft answer consumes only that question and creates no declaration", async () => {
    const { admission, question, view } = await admit(
      "installmentCount",
      "2",
      false,
      true,
    );
    expect(view.lines[0].installmentCount).toBe(1);
    const result = await bridge.editAnswer(admission, {
      kind: "VALUE",
      field: "installmentCount",
      evidence: { start: 0, end: 1 },
      value: 2,
    });
    expect(result).toMatchObject({ acknowledgment: "EDITED" });
    const current = await get();
    expect(current.lines[0].installmentCount).toBe(2);
    expect(current.questions.some((item) => item.id === question.id)).toBe(
      false,
    );
    expect(current.questions.map((item) => item.id)).toEqual(
      view.questions
        .filter((item) => item.id !== question.id)
        .map((item) => item.id),
    );
    expect(current.declaredFacts).toEqual([]);
    expect(parseStoredDraft((await row()).draftJson)).not.toHaveProperty(
      "declarations",
    );
  });
  it("revocation leaves UNKNOWN, preserves originals, and does not auto-repeat that question", async () => {
    await answer("installmentCount", "1");
    await answer("installmentCount", "remover");
    const view = await get();
    expect(
      view.declaredFacts.find((item) => item.field === "installmentCount"),
    ).toMatchObject({ value: null, status: "UNKNOWN" });
    expect(
      view.questions.find(
        (item) => "subject" in item && item.field === "installmentCount",
      ),
    ).toMatchObject({ answerState: "UNKNOWN" });
    expect(view.reviewBlockers[0].resolution).toBe("NEEDS_DECLARATION");
  });
  it("rejects documentary ATTACHMENT broadcast before writing", async () => {
    const { admission } = await admit("installmentCount", "1", true);
    const before = await row();
    await expect(
      bridge.editAnswer(admission, { kind: "INVALID" }),
    ).rejects.toThrow();
    expect(await row()).toEqual(before);
  });
  it("rejects stale focus/revision and an admission replay", async () => {
    const { admission, view } = await admit("installmentCount", "1");
    const interpretation = {
      kind: "VALUE",
      field: "installmentCount",
      evidence: { start: 0, end: 1 },
      value: 3,
    };
    await bridge.editAnswer(admission, interpretation);
    await expect(
      bridge.editAnswer(admission, interpretation),
    ).rejects.toThrow();
    expect((await get()).revision).toBe(view.revision + 1);
  });
  it("confirmation attests the set without rewriting individual answers, then execution reuses human support", async () => {
    await answer("amountMeaning", "valor da parcela");
    await answer("installmentCount", "1");
    const declarations = parseStoredDraft((await row()).draftJson).declarations;
    const current = await get();
    const prepared = await h.call("POST", route("/prepare"), {
      token,
      headers: UI_HEADERS,
      body: { expectedRevision: current.revision },
    });
    expect(prepared.status).toBe(200);
    expect(prepared.json.state).toBe("READY");
    h.clock.current = new Date(FIXED_NOW.getTime() + 120_000);
    jest.setSystemTime(h.clock.current);
    const expectedRevision = prepared.json.revision;
    const proposalHash = prepared.json.proposal.proposalHash;
    const challenge = await h.call("POST", route("/confirmation-challenge"), {
      token,
      headers: UI_HEADERS,
      body: { expectedRevision, proposalHash },
    });
    expect(challenge.status).toBe(200);
    const confirmed = await h.call("POST", route("/confirm"), {
      token,
      headers: UI_HEADERS,
      body: {
        expectedRevision,
        proposalHash,
        nonce: challenge.json.nonce,
        financialRequestId: randomUUID(),
      },
    });
    expect(confirmed.status).toBe(200);
    expect(parseStoredDraft((await row()).draftJson).declarations).toEqual(
      declarations,
    );
    const executed = await h.call("POST", route("/execute"), {
      token,
      headers: UI_HEADERS,
      body: { financialRequestId: confirmed.json.financialRequestId },
    });
    expect(executed.status).toBe(200);
    const source = await fixture.setup.expense.findFirstOrThrow({
      where: { tenantId: world.tenantId },
    });
    expect(source.documentedSchedule).toContain("user-attestation");
    expect(source.documentedSchedule).toContain(h.clock.current.toISOString());
    expect(source.documentedSchedule).toContain("SHA-256");
    const terminal = await get();
    expect(terminal.state).toBe("APPLIED");
    expect(terminal.declaredFacts).toEqual([]);
    expect(terminal.questions.filter((item) => "subject" in item)).toEqual([]);
    writeFileSync(
      join(fixture.directory, "confirmed-human-support.json"),
      JSON.stringify({
        declarations,
        confirmedAt: (await row()).confirmedAt,
        receipt: executed.json,
        provenance: source.documentedSchedule,
      }),
      { mode: 0o600 },
    );
  });
});
