import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  ExpectedRequestAbortConsoleFailure,
  JourneyEvidence,
  meetsMinimumTouchTarget,
} from "../../../../../../e2e-qa/helpers/evidence";

describe("meetsMinimumTouchTarget", () => {
  it.each([
    { width: 44, height: 44, expected: true },
    { width: 43.99, height: 100, expected: false },
    { width: 100, height: 43.99, expected: false },
  ])("requires both dimensions for %#", ({ width, height, expected }) => {
    expect(meetsMinimumTouchTarget({ width, height })).toBe(expected);
  });
});

describe("ExpectedRequestAbortConsoleFailure", () => {
  const expected = {
    phase: "confirmation",
    method: "POST",
    url: "http://api.test/import-sessions/session-1/execute",
  };
  const failedResource = {
    text: "Failed to load resource: net::ERR_FAILED",
    locationUrl: expected.url,
  };
  const failedRequest = {
    method: expected.method,
    url: expected.url,
    errorText: "net::ERR_FAILED",
  };

  it.each(["console-before-abort", "console-after-abort"] as const)(
    "accepts exactly one correlated failure in the %s event order",
    (order) => {
      const allowance = new ExpectedRequestAbortConsoleFailure(expected);

      if (order === "console-before-abort")
        expect(allowance.consumeConsoleError(failedResource)).toBe(true);
      allowance.recordRouteAbort(expected);
      expect(allowance.recordRequestFailure(failedRequest)).toBe(true);
      if (order === "console-after-abort")
        expect(allowance.consumeConsoleError(failedResource)).toBe(true);

      expect(() => allowance.assertSatisfied()).not.toThrow();
      expect(allowance.snapshot()).toEqual({
        ...expected,
        routeAbortCount: 1,
        requestFailureCount: 1,
        consoleFailureCount: 1,
      });
    },
  );

  it.each(["route-abort", "request-failure", "console-failure"] as const)(
    "fails when the expected %s occurs zero times",
    (missing) => {
      const absent = new ExpectedRequestAbortConsoleFailure(expected);
      if (missing !== "route-abort") absent.recordRouteAbort(expected);
      if (missing !== "request-failure")
        expect(absent.recordRequestFailure(failedRequest)).toBe(true);
      if (missing !== "console-failure")
        expect(absent.consumeConsoleError(failedResource)).toBe(true);

      expect(() => absent.assertSatisfied()).toThrow(/exactly one/);
    },
  );

  it.each(["route-abort", "request-failure", "console-failure"] as const)(
    "fails when the expected %s occurs more than once",
    (duplicateEvent) => {
      const duplicate = new ExpectedRequestAbortConsoleFailure(expected);
      duplicate.recordRouteAbort(expected);
      expect(duplicate.recordRequestFailure(failedRequest)).toBe(true);
      expect(duplicate.consumeConsoleError(failedResource)).toBe(true);

      if (duplicateEvent === "route-abort")
        duplicate.recordRouteAbort(expected);
      if (duplicateEvent === "request-failure")
        expect(duplicate.recordRequestFailure(failedRequest)).toBe(true);
      if (duplicateEvent === "console-failure")
        expect(duplicate.consumeConsoleError(failedResource)).toBe(true);

      expect(() => duplicate.assertSatisfied()).toThrow(/exactly one/);
    },
  );

  it.each([
    { ...expected, phase: "upload" },
    { ...expected, method: "GET" },
    {
      ...expected,
      url: "http://api.test/import-sessions/other-session/execute",
    },
  ])(
    "rejects an abort outside the exact phase/method/session scope",
    (actual) => {
      const allowance = new ExpectedRequestAbortConsoleFailure(expected);
      expect(() => allowance.recordRouteAbort(actual)).toThrow(
        /Expected request abort/,
      );
    },
  );

  it.each([
    { ...failedRequest, method: "GET" },
    {
      ...failedRequest,
      url: "http://api.test/import-sessions/other-session/execute",
    },
    { ...failedRequest, errorText: "net::ERR_ABORTED" },
  ])("does not correlate an unrelated failed request", (failure) => {
    const allowance = new ExpectedRequestAbortConsoleFailure(expected);

    expect(allowance.recordRequestFailure(failure)).toBe(false);
    expect(allowance.snapshot().requestFailureCount).toBe(0);
  });

  it.each([
    {
      text: "Failed to load resource: net::ERR_FAILED",
      locationUrl: "http://api.test/import-sessions/other-session/execute",
    },
    {
      text: "Failed to load resource: net::ERR_FAILED",
      locationUrl: "",
    },
    {
      text: "Failed to load resource: net::ERR_ABORTED",
      locationUrl: expected.url,
    },
    {
      text: "Unrelated console error",
      locationUrl: expected.url,
    },
  ])("does not consume an unrelated browser console error", (error) => {
    const allowance = new ExpectedRequestAbortConsoleFailure(expected);

    expect(allowance.consumeConsoleError(error)).toBe(false);
    expect(allowance.snapshot().consoleFailureCount).toBe(0);
  });
});

describe("JourneyEvidence expected request aborts", () => {
  const expected = {
    phase: "confirmation-lost-answer",
    method: "PATCH",
    url: "http://api.test/import-sessions/session-1/draft",
  };

  it("correlates a pre-registered PATCH /draft abort even when browser events arrive first", () => {
    const page = new EventEmitter();
    const evidence = new JourneyEvidence(
      page as never,
      {
        project: { name: "unit" },
        title: "unit evidence",
      } as never,
    );
    const allowance = evidence.expectRequestAbortConsoleFailure(expected);

    page.emit("requestfailed", {
      method: () => expected.method,
      url: () => expected.url,
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    });
    page.emit("console", {
      type: () => "error",
      text: () => "Failed to load resource: net::ERR_FAILED",
      location: () => ({ url: expected.url }),
    });
    allowance.recordRouteAbort(expected);

    expect(() => evidence.assertClean()).not.toThrow();
    expect(allowance.snapshot()).toEqual({
      ...expected,
      routeAbortCount: 1,
      requestFailureCount: 1,
      consoleFailureCount: 1,
    });
  });
});

describe("JourneyEvidence expected HTTP console failures", () => {
  const expected = {
    phase: "voice CSV entry",
    status: 503 as const,
    method: "POST",
    url: "http://api.test/tts/stream",
    reason: "Private-vault QA intentionally runs without VibeVoice.",
  };
  const failedResource = {
    type: () => "error",
    text: () =>
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    location: () => ({ url: expected.url }),
  };
  const response = (url: string, status = 503, method = "POST") => ({
    status: () => status,
    request: () => ({ method: () => method }),
    url: () => url,
  });

  function buildEvidence() {
    const page = new EventEmitter();
    const evidence = new JourneyEvidence(
      page as never,
      {
        project: { name: "unit" },
        title: "unit evidence",
      } as never,
    );
    evidence.expectHttpFailureConsoleError(expected);
    return { evidence, page };
  }

  it("accepts an absent 503 pair when TTS is not attempted", () => {
    const { evidence } = buildEvidence();

    expect(() => evidence.assertClean()).not.toThrow();
  });

  it.each([
    {
      name: "HTTP response only",
      emit: (page: EventEmitter) =>
        page.emit("response", response(expected.url)),
    },
    {
      name: "console diagnostic only",
      emit: (page: EventEmitter) => page.emit("console", failedResource),
    },
  ])("rejects a one-sided expected 503 pair: $name", ({ emit }) => {
    const { evidence, page } = buildEvidence();

    emit(page);

    expect(() => evidence.assertClean()).toThrow(
      /both absent or exactly one matched pair/,
    );
  });

  it.each(["response-first", "console-first"] as const)(
    "accepts the exact expected 503 and Chromium diagnostic in %s order",
    (order) => {
      const { evidence, page } = buildEvidence();

      if (order === "response-first")
        page.emit("response", response(expected.url));
      page.emit("console", failedResource);
      if (order === "console-first")
        page.emit("response", response(expected.url));

      expect(() => evidence.assertClean()).not.toThrow();
    },
  );

  it.each([
    {
      name: "503 response from another URL",
      emit: (page: EventEmitter) =>
        page.emit("response", response("http://api.test/unrelated")),
      expectedMessage: /Unexpected 4xx\/5xx responses/,
    },
    {
      name: "502 response from the expected URL",
      emit: (page: EventEmitter) =>
        page.emit("response", response(expected.url, 502)),
      expectedMessage: /Unexpected 4xx\/5xx responses/,
    },
    {
      name: "503 GET response from the expected URL",
      emit: (page: EventEmitter) =>
        page.emit("response", response(expected.url, 503, "GET")),
      expectedMessage: /Unexpected 4xx\/5xx responses/,
    },
    {
      name: "503 console diagnostic from another URL",
      emit: (page: EventEmitter) =>
        page.emit("console", {
          ...failedResource,
          location: () => ({ url: "http://api.test/unrelated" }),
        }),
      expectedMessage: /Unexpected browser console\/page errors/,
    },
    {
      name: "duplicate expected 503 response",
      emit: (page: EventEmitter) =>
        page.emit("response", response(expected.url)),
      expectedMessage: /both absent or exactly one matched pair/,
    },
    {
      name: "duplicate expected 503 console diagnostic",
      emit: (page: EventEmitter) => page.emit("console", failedResource),
      expectedMessage: /both absent or exactly one matched pair/,
    },
  ])(
    "still fails for an unrelated failure: $name",
    ({ emit, expectedMessage }) => {
      const { evidence, page } = buildEvidence();
      page.emit("response", response(expected.url));
      page.emit("console", failedResource);

      emit(page);

      expect(() => evidence.assertClean()).toThrow(expectedMessage);
    },
  );
});
