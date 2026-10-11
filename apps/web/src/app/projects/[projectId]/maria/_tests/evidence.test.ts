import { describe, expect, it } from "vitest";
import {
  ExpectedRequestAbortConsoleFailure,
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
