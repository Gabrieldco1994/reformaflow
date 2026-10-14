import { evaluateOfflineReport } from "./offline-report";

describe("offline application-owned report", () => {
  it("reuses the parser and evaluator and preserves explicit P1 deferral", async () => {
    const input = { datasetVersion: "candidate" } as never;
    const report = {
      reportSchemaVersion: 4,
      historicalComparison: "NOT_PERFORMED_P1_DEFERRED",
      releaseStatus: "PASS",
    } as never;
    const parse = jest.fn(() => input);
    const evaluate = jest.fn(async () => report);
    const issueToken = jest.fn(async () => undefined);

    await expect(
      evaluateOfflineReport('{"raw":true}', {
        parse,
        evaluate,
        issueToken,
      }),
    ).resolves.toBe(report);
    expect(parse).toHaveBeenCalledWith('{"raw":true}');
    expect(issueToken).toHaveBeenCalledWith(input);
    expect(evaluate).toHaveBeenCalledWith(input, undefined);
  });

  it("does not convert parser failure into a caller-owned report", async () => {
    await expect(
      evaluateOfflineReport("{}", {
        parse: () => {
          throw new Error("LIVE_EVIDENCE_INVALID");
        },
      }),
    ).rejects.toThrow("LIVE_EVIDENCE_INVALID");
  });
});
