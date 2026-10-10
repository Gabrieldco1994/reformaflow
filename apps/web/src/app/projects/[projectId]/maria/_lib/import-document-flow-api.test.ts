import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type {
  ImportSessionCreateRequestV1,
  ImportSessionReserveRequestV1,
  ImportSessionRevisionRequestV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";
import { ApiResponseError, ApiTimeoutError } from "@/lib/api";
import {
  analyzeImportAttachment,
  createImportSession,
  ImportMalformedResponseError,
  reserveImportSessionAttachments,
  uploadImportSessionAttachment,
} from "./import-session-api";
import { ImportWorkflowResponseError } from "./import-session-workflow-read";
import { viewFixture } from "./import-session-fixtures";

const requestId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const createRequest: ImportSessionCreateRequestV1 = {
  version: 1,
  createRequestId: requestId,
  cardId: "card-1",
  consentPolicyVersion: 1,
  consentAnalyze: true,
};
const reserveRequest: ImportSessionReserveRequestV1 = {
  expectedRevision: 3,
  files: [
    {
      id: attachmentId,
      fileName: "documento.pdf",
      declaredBytes: 6,
      mime: "application/pdf",
    },
  ],
};
const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
const documentBlob = () => new Blob([bytes], { type: "application/pdf" });
const fullView = (): ImportSessionViewV1 =>
  viewFixture({
    revision: 4,
    searchComplete: false,
    attachments: [
      {
        id: attachmentId,
        fileName: "documento.pdf",
        declaredBytes: bytes.length,
        state: "ATTACHED",
        materializedInSession: false,
        canAnalyze: false,
      },
    ],
  });
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const fetchStub = vi.fn<typeof fetch>();
const writes = [
  {
    name: "create",
    call: (signal?: AbortSignal) => createImportSession(createRequest, signal),
  },
  {
    name: "reserve",
    call: (signal?: AbortSignal) =>
      reserveImportSessionAttachments("sess-1", reserveRequest, signal),
  },
  {
    name: "upload",
    call: (signal?: AbortSignal) =>
      uploadImportSessionAttachment(
        "sess-1",
        attachmentId,
        documentBlob(),
        signal,
      ),
  },
];

beforeEach(() => {
  fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
  // The shared helper's 401 handling stays in the real request path without jsdom navigation.
  window.history.replaceState(null, "", "/login");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function expectRequest(
  path: string,
  method: string,
  body: BodyInit,
  contentType: string,
) {
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [url, options] = fetchStub.mock.calls[0];
  const parsed = new URL(String(url), "http://localhost:3001");
  expect(parsed.pathname + parsed.search).toBe(path);
  expect(options?.method).toBe(method);
  expect(options?.body).toBe(body);
  expect(options?.credentials).toBe("include");
  expect(options?.headers).toEqual({
    "Content-Type": contentType,
    "x-rf-import-ui": "1",
  });
  expect(options?.signal).toBeInstanceOf(AbortSignal);
}

describe("inactive document intake clients: real API helper and paired X3 reader", () => {
  it("uses the existing domain request and full-view return types", () => {
    expectTypeOf(createImportSession).parameters.toEqualTypeOf<
      [request: ImportSessionCreateRequestV1, signal?: AbortSignal]
    >();
    expectTypeOf(reserveImportSessionAttachments).parameters.toEqualTypeOf<
      [id: string, request: ImportSessionReserveRequestV1, signal?: AbortSignal]
    >();
    expectTypeOf(uploadImportSessionAttachment).parameters.toEqualTypeOf<
      [id: string, attachmentId: string, body: Blob, signal?: AbortSignal]
    >();
    expectTypeOf(
      createImportSession,
    ).returns.resolves.toEqualTypeOf<ImportSessionViewV1>();
    expectTypeOf(
      reserveImportSessionAttachments,
    ).returns.resolves.toEqualTypeOf<ImportSessionViewV1>();
    expectTypeOf(
      uploadImportSessionAttachment,
    ).returns.resolves.toEqualTypeOf<ImportSessionViewV1>();
  });

  it.each([201, 200])(
    "create accepts HTTP %i and sends only the supplied consent/request",
    async (status) => {
      const view = viewFixture({
        revision: 1,
        attachments: [],
        searchComplete: false,
      });
      const request = structuredClone(createRequest);
      fetchStub.mockResolvedValue(reply(view, status));
      await expect(createImportSession(request)).resolves.toEqual(view);
      expectRequest(
        "/import-sessions",
        "POST",
        JSON.stringify(createRequest),
        "application/json",
      );
      expect(request).toEqual(createRequest);
    },
  );

  it("reserve preserves the caller's revision, IDs and declared MIME", async () => {
    const view = fullView();
    view.attachments[0].state = "RESERVED";
    const request = structuredClone(reserveRequest);
    fetchStub.mockResolvedValue(reply(view));
    await expect(
      reserveImportSessionAttachments("sess-1", request),
    ).resolves.toEqual(view);
    expectRequest(
      "/import-sessions/sess-1/attachments",
      "POST",
      JSON.stringify(reserveRequest),
      "application/json",
    );
    expect(request).toEqual(reserveRequest);
  });

  it("upload preserves binary bytes/body identity and returns ATTACHED without claiming materialization", async () => {
    const body = documentBlob();
    const view = fullView();
    fetchStub.mockResolvedValue(reply(view));
    const result = await uploadImportSessionAttachment(
      "sess-1",
      attachmentId,
      body,
    );
    expect(result).toEqual(view);
    expect(result.lines).toEqual([]);
    expect(result.searchComplete).toBe(false);
    expect(Object.keys(result.attachments[0]).sort()).toEqual([
      "canAnalyze",
      "declaredBytes",
      "fileName",
      "id",
      "materializedInSession",
      "state",
    ]);
    expectRequest(
      `/import-sessions/sess-1/attachments/${attachmentId}/content`,
      "PUT",
      body,
      "application/octet-stream",
    );
    const decoded = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new Error("Expected binary Blob contents"));
          return;
        }
        resolve(reader.result);
      };
      reader.readAsArrayBuffer(body);
    });
    expect(Array.from(new Uint8Array(decoded))).toEqual([
      0, 255, 128, 13, 10, 42,
    ]);
  });

  it("encodes both IDs without manufacturing a query or changing the body", async () => {
    const error = reply({ message: "Invalid id" }, 400);
    fetchStub.mockResolvedValue(error);
    await expect(
      reserveImportSessionAttachments("s/a ?#", reserveRequest),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expectRequest(
      "/import-sessions/s%2Fa%20%3F%23/attachments",
      "POST",
      JSON.stringify(reserveRequest),
      "application/json",
    );
    fetchStub
      .mockReset()
      .mockResolvedValue(reply({ message: "Invalid id" }, 400));
    const body = documentBlob();
    await expect(
      uploadImportSessionAttachment("s/a ?#", "a/b ?#", body),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expectRequest(
      "/import-sessions/s%2Fa%20%3F%23/attachments/a%2Fb%20%3F%23/content",
      "PUT",
      body,
      "application/octet-stream",
    );
  });

  it("rejects a create response for another card", async () => {
    fetchStub.mockResolvedValue(reply(viewFixture({ cardId: "another-card" })));
    await expect(createImportSession(createRequest)).rejects.toBeInstanceOf(
      ImportMalformedResponseError,
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each(writes.slice(1))(
    "$name rejects another session's otherwise valid view",
    async ({ call }) => {
      fetchStub.mockResolvedValue(
        reply({ ...fullView(), id: "another-session" }),
      );
      await expect(call()).rejects.toBeInstanceOf(ImportMalformedResponseError);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["RESERVED", "UPLOADED", "FAILED", "RELEASED"] as const)(
    "upload rejects a response where the requested reference is %s",
    async (state) => {
      const view = fullView();
      view.attachments[0].state = state;
      fetchStub.mockResolvedValue(reply(view));
      await expect(
        uploadImportSessionAttachment("sess-1", attachmentId, documentBlob()),
      ).rejects.toBeInstanceOf(ImportMalformedResponseError);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { attachments: [] },
    {
      attachments: [
        {
          id: "another-ref",
          fileName: "outro.pdf",
          declaredBytes: 6,
          state: "ATTACHED",
          materializedInSession: false,
          canAnalyze: false,
        },
      ],
    },
  ])(
    "upload rejects a missing requested reference",
    async ({ attachments }) => {
      fetchStub.mockResolvedValue(reply({ ...fullView(), attachments }));
      await expect(
        uploadImportSessionAttachment("sess-1", attachmentId, documentBlob()),
      ).rejects.toBeInstanceOf(ImportMalformedResponseError);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );

  describe.each(writes)(
    "$name failure and cancellation boundaries",
    ({ call }) => {
      it.each<[string, () => unknown]>([
        ["null", () => null],
        [
          "missing full-view fields",
          () => ({ id: "sess-1", state: "DRAFT", revision: 4 }),
        ],
        ["extra field", () => ({ ...fullView(), privateScope: {} })],
        ["invalid attachment", () => ({ ...fullView(), attachments: [null] })],
        [
          "contradictory documentary flags are not accepted",
          () => ({
            ...fullView(),
            attachments: fullView().attachments.map((attachment) => ({
              ...attachment,
              materializedInSession: true,
              canAnalyze: true,
            })),
          }),
        ],
      ])("rejects malformed success: %s", async (_name, value) => {
        fetchStub.mockResolvedValue(reply(value()));
        await expect(call()).rejects.toBeInstanceOf(
          ImportWorkflowResponseError,
        );
        expect(fetchStub).toHaveBeenCalledTimes(1);
      });

      it.each([401, 409, 503])(
        "preserves HTTP %i without retry or fallback",
        async (status) => {
          const body = { message: "Rejected", code: "REVISION_CONFLICT" };
          fetchStub.mockResolvedValue(reply(body, status));
          await expect(call()).rejects.toMatchObject({
            name: "ApiResponseError",
            status,
            body,
          });
          expect(fetchStub).toHaveBeenCalledTimes(1);
        },
      );

      it("rejects empty or invalid JSON success without retry", async () => {
        fetchStub.mockResolvedValueOnce(new Response(""));
        await expect(call()).rejects.toBeInstanceOf(
          ImportWorkflowResponseError,
        );
        fetchStub.mockResolvedValueOnce(new Response("{broken"));
        await expect(call()).rejects.toBeInstanceOf(SyntaxError);
        expect(fetchStub).toHaveBeenCalledTimes(2);
      });

      it("propagates a lost response without creating another operation", async () => {
        const failure = new TypeError("Connection lost");
        fetchStub.mockRejectedValue(failure);
        await expect(call()).rejects.toBe(failure);
        expect(fetchStub).toHaveBeenCalledTimes(1);
      });

      it("does not fetch for a pre-aborted caller", async () => {
        const caller = new AbortController();
        caller.abort();
        await expect(call(caller.signal)).rejects.toMatchObject({
          name: "AbortError",
        });
        expect(fetchStub).not.toHaveBeenCalled();
      });

      it("aborts in flight, removes listeners/timers and does not retry", async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, "removeEventListener");
        fetchStub.mockImplementation(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        );
        const request = call(caller.signal);
        const assertion = expect(request).rejects.toMatchObject({
          name: "AbortError",
        });
        caller.abort();
        await assertion;
        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
      });

      it("uses the unchanged 25-second deadline and cleans up", async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, "removeEventListener");
        fetchStub.mockImplementation(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        );
        const request = call(caller.signal);
        const assertion =
          expect(request).rejects.toBeInstanceOf(ApiTimeoutError);
        await vi.advanceTimersByTimeAsync(24_999);
        expect(fetchStub.mock.calls[0][1]?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await assertion;
        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
      });

      it("cleans up a successful request without mutating its server revision", async () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, "removeEventListener");
        const view = fullView();
        fetchStub.mockResolvedValue(reply(view));
        await expect(call(caller.signal)).resolves.toEqual(view);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        caller.abort();
        expect(fetchStub.mock.calls[0][1]?.signal?.aborted).toBe(false);
        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      });
    },
  );
});

describe("explicit EXTRACTED reference analysis, not a RAW executor", () => {
  const completed = () => {
    const view = fullView();
    view.attachments[0].materializedInSession = true;
    return view;
  };
  it("pins the domain revision DTO and preserves completed replay/zero observations", async () => {
    expectTypeOf(analyzeImportAttachment).parameters.toEqualTypeOf<
      [
        sessionId: string,
        attachmentId: string,
        request: ImportSessionRevisionRequestV1,
        signal?: AbortSignal,
      ]
    >();
    const view = completed();
    fetchStub.mockResolvedValue(reply(view));
    const result = await analyzeImportAttachment("sess-1", attachmentId, {
      expectedRevision: 4,
    });
    expectRequest(
      `/import-sessions/sess-1/attachments/${attachmentId}/analyze`,
      "POST",
      '{"expectedRevision":4}',
      "application/json",
    );
    expect(result).toEqual(view);
    expect(result.lines).toEqual([]);
    expect(result.actions).not.toContain("PREPARE");
  });
  it("encodes IDs in the path without admitting illegal IDs in the response", async () => {
    fetchStub.mockResolvedValue(reply(completed()));
    await expect(
      analyzeImportAttachment("sess/1", "ref/1", { expectedRevision: 4 }),
    ).rejects.toBeInstanceOf(ImportMalformedResponseError);
    expectRequest(
      "/import-sessions/sess%2F1/attachments/ref%2F1/analyze",
      "POST",
      '{"expectedRevision":4}',
      "application/json",
    );
  });
  it.each([
    ["another session", () => ({ ...completed(), id: "other" })],
    [
      "another reference",
      () => ({
        ...completed(),
        attachments: [{ ...completed().attachments[0], id: "other" }],
      }),
    ],
    ["still pending", fullView],
    ["missing blockers", () => ({ ...completed(), reviewBlockers: undefined })],
    [
      "missing flags",
      () => ({
        ...completed(),
        attachments: [{ ...completed().attachments[0], canAnalyze: undefined }],
      }),
    ],
    ["invalid JSON shape", () => ({ ok: true })],
  ])("rejects success with %s without a second write", async (_name, value) => {
    fetchStub.mockResolvedValue(reply(value()));
    await expect(
      analyzeImportAttachment("sess-1", attachmentId, { expectedRevision: 4 }),
    ).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
  it.each([401, 409, 503])(
    "preserves HTTP %i without retries",
    async (status) => {
      fetchStub.mockResolvedValue(
        reply({ privateMessage: "not trusted" }, status),
      );
      await expect(
        analyzeImportAttachment("sess-1", attachmentId, {
          expectedRevision: 4,
        }),
      ).rejects.toMatchObject({ status });
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );
  it("does not fetch an already aborted operation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeImportAttachment(
        "sess-1",
        attachmentId,
        { expectedRevision: 4 },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
