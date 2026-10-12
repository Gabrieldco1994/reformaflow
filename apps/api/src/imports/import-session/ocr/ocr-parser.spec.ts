import { parseOcrV1 } from "./ocr-parser";

type RegionRefFixture = {
  pageNumber: number;
  regionIndex: number;
};

const ref = (pageNumber: number, regionIndex: number): RegionRefFixture => ({
  pageNumber,
  regionIndex,
});

const manifest = (
  regions: readonly RegionRefFixture[],
  pageCount = 1,
): Record<string, unknown> => ({
  version: 1,
  pageCount,
  regions: [...regions],
});

const rawCandidate = (
  amountCents: unknown = "1250",
  dateText: unknown = null,
): Record<string, unknown> => ({
  amountCents,
  dateText,
});

const complete = (
  pageNumber: number,
  regionIndex: number,
  candidates: readonly unknown[] = [rawCandidate()],
): Record<string, unknown> => ({
  pageNumber,
  regionIndex,
  status: "COMPLETE",
  candidates: [...candidates],
});

const failed = (
  pageNumber: number,
  regionIndex: number,
): Record<string, unknown> => ({
  pageNumber,
  regionIndex,
  status: "FAILED",
  candidates: [],
});

const payload = (
  regions: readonly unknown[],
  version: unknown = 1,
): Record<string, unknown> => ({
  version,
  regions: [...regions],
});

const parseFixture = (inputManifest: unknown, inputPayload: unknown) =>
  parseOcrV1(inputPayload, inputManifest);

const parseOne = (amountCents: unknown, dateText: unknown = null) =>
  parseFixture(
    manifest([ref(1, 1)]),
    payload([complete(1, 1, [rawCandidate(amountCents, dateText)])]),
  );

const expectFailure = (result: unknown, code: string): void => {
  expect(result).toEqual({ ok: false, error: { code } });
};

describe("parseOcrV1", () => {
  it("returns candidates in manifest order and assigns unverified state", () => {
    const result = parseFixture(
      manifest([ref(1, 1), ref(1, 2), ref(2, 1)], 2),
      payload([
        complete(2, 1, [rawCandidate("400", "2025-07-08")]),
        complete(1, 2, []),
        complete(1, 1, [rawCandidate("1250", "8/7/2025")]),
      ]),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        version: 1,
        accounting: { pageCount: 2, regionCount: 3, candidateCount: 2 },
        regions: [
          {
            pageNumber: 1,
            regionIndex: 1,
            candidates: [
              {
                amountCents: "1250",
                date: "2025-07-08",
                verificationStatus: "UNVERIFIED",
                selected: false,
              },
            ],
          },
          { pageNumber: 1, regionIndex: 2, candidates: [] },
          {
            pageNumber: 2,
            regionIndex: 1,
            candidates: [
              {
                amountCents: "400",
                date: "2025-07-08",
                verificationStatus: "UNVERIFIED",
                selected: false,
              },
            ],
          },
        ],
      },
    });
  });

  it.each(["VERIFIED", "UNVERIFIED", "APPROVED"])(
    "rejects provider verificationStatus %s",
    (verificationStatus) => {
      const providerCandidate = {
        ...rawCandidate(),
        verificationStatus,
      };
      expectFailure(
        parseFixture(
          manifest([ref(1, 1)]),
          payload([complete(1, 1, [providerCandidate])]),
        ),
        "INVALID_PAYLOAD",
      );
    },
  );

  it.each([true, false])("rejects provider selected=%s", (selected) => {
    const providerCandidate = { ...rawCandidate(), selected };
    expectFailure(
      parseFixture(
        manifest([ref(1, 1)]),
        payload([complete(1, 1, [providerCandidate])]),
      ),
      "INVALID_PAYLOAD",
    );
  });

  it("accepts canonical cent strings at both inclusive bounds", () => {
    expect(parseOne("1")).toEqual({
      ok: true,
      value: {
        version: 1,
        accounting: { pageCount: 1, regionCount: 1, candidateCount: 1 },
        regions: [
          {
            pageNumber: 1,
            regionIndex: 1,
            candidates: [
              {
                amountCents: "1",
                date: null,
                verificationStatus: "UNVERIFIED",
                selected: false,
              },
            ],
          },
        ],
      },
    });
    expect(parseOne("2147483647")).toEqual({
      ok: true,
      value: {
        version: 1,
        accounting: { pageCount: 1, regionCount: 1, candidateCount: 1 },
        regions: [
          {
            pageNumber: 1,
            regionIndex: 1,
            candidates: [
              {
                amountCents: "2147483647",
                date: null,
                verificationStatus: "UNVERIFIED",
                selected: false,
              },
            ],
          },
        ],
      },
    });
  });

  it.each([
    "0",
    "-1",
    "01",
    "2147483648",
    "",
    "1.0",
    "1e2",
    "+1",
    " 1",
    "1 ",
    "0001",
    0,
    1,
    2147483647,
  ])("rejects invalid amountCents %p", (amountCents) => {
    expectFailure(parseOne(amountCents), "INVALID_AMOUNT_CENTS");
  });

  it.each([
    ["3/4/2024", "2024-04-03"],
    ["03/04/2024", "2024-04-03"],
    ["2024-04-03", "2024-04-03"],
    ["29/02/2000", "2000-02-29"],
    ["29/2/2024", "2024-02-29"],
    ["01/01/1900", "1900-01-01"],
    ["31/12/2199", "2199-12-31"],
  ])("normalizes explicit date %s to %s", (dateText, expectedDate) => {
    expect(parseOne("1", dateText)).toMatchObject({
      ok: true,
      value: {
        regions: [
          {
            candidates: [{ amountCents: "1", date: expectedDate }],
          },
        ],
      },
    });
  });

  it.each(["1/2", "01/02", "29/2"])(
    "does not infer a year from valid yearless date %s",
    (dateText) => {
      expect(parseOne("1", dateText)).toMatchObject({
        ok: true,
        value: {
          regions: [
            {
              candidates: [{ amountCents: "1", date: null }],
            },
          ],
        },
      });
    },
  );

  it.each([
    "31/04/2024",
    "29/02/1900",
    "29/02/2100",
    "2023-02-29",
    "2024-02-30",
    "1900-02-29",
    "1899-12-31",
    "2200-01-01",
    "1/2/24",
    "1/2/202",
    "01/02/0200",
    "31/4",
    "",
    "2024-1-02",
    " 1/2/2024",
    "1/2/2024 ",
    "00/1/2024",
    "12/32/2024",
    20240101,
  ])("rejects invalid dateText %p", (dateText) => {
    expectFailure(parseOne("1", dateText), "INVALID_DATE");
  });

  it("rejects missing, extra, and duplicate payload region pairs", () => {
    expectFailure(
      parseFixture(manifest([ref(1, 1), ref(1, 2)]), payload([complete(1, 1)])),
      "REGION_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(
        manifest([ref(1, 1)]),
        payload([complete(1, 1), complete(1, 2)]),
      ),
      "REGION_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(
        manifest([ref(1, 1)]),
        payload([complete(1, 1), complete(1, 1)]),
      ),
      "REGION_ACCOUNTING_MISMATCH",
    );
  });

  it("accepts the maximum page count when every page is represented", () => {
    const regions = Array.from({ length: 30 }, (_, index) => ref(index + 1, 1));
    const result = parseFixture(
      manifest(regions, 30),
      payload(
        regions.map(({ pageNumber, regionIndex }) =>
          complete(pageNumber, regionIndex, [rawCandidate(String(pageNumber))]),
        ),
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        accounting: { pageCount: 30, regionCount: 30, candidateCount: 30 },
      },
    });
  });

  it("rejects invalid manifest page counts, ranges, and coverage", () => {
    const validPayload = payload([complete(1, 1)]);

    expectFailure(
      parseFixture(manifest([ref(1, 1)], 0), validPayload),
      "PAGE_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 1)], 31), validPayload),
      "PAGE_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 1)], 2), validPayload),
      "PAGE_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 1), ref(3, 1)], 2), validPayload),
      "PAGE_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 1), ref(2, 1)], 3), validPayload),
      "PAGE_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([], 1), payload([])),
      "PAGE_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(
        { version: 1, pageCount: 1.5, regions: [ref(1, 1)] },
        validPayload,
      ),
      "INVALID_MANIFEST",
    );
    expectFailure(
      parseFixture(
        { version: 1, pageCount: "1", regions: [ref(1, 1)] },
        validPayload,
      ),
      "INVALID_MANIFEST",
    );
    expectFailure(
      parseFixture(manifest([ref(0, 1)]), validPayload),
      "PAGE_ACCOUNTING_MISMATCH",
    );
  });

  it("rejects non-unique, unsorted, or non-contiguous manifest region indices", () => {
    const singlePayload = payload([complete(1, 1)]);

    expectFailure(
      parseFixture(manifest([ref(1, 1), ref(1, 1)]), singlePayload),
      "REGION_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 2), ref(1, 1)]), singlePayload),
      "REGION_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 1), ref(1, 3)]), singlePayload),
      "REGION_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 0)]), singlePayload),
      "REGION_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(manifest([ref(1, -1)]), singlePayload),
      "REGION_ACCOUNTING_MISMATCH",
    );
    expectFailure(
      parseFixture(
        {
          version: 1,
          pageCount: 1,
          regions: [{ pageNumber: "1", regionIndex: 1 }],
        },
        singlePayload,
      ),
      "INVALID_MANIFEST",
    );
  });

  it("rejects a failed region even when another region has valid candidates", () => {
    expectFailure(
      parseFixture(
        manifest([ref(1, 1), ref(1, 2)]),
        payload([
          complete(1, 1, [rawCandidate("500", "1/2/2024")]),
          failed(1, 2),
        ]),
      ),
      "REGION_FAILED",
    );
  });

  it("rejects a document whose complete regions contain no candidates", () => {
    expectFailure(
      parseFixture(
        manifest([ref(1, 1), ref(1, 2)]),
        payload([complete(1, 1, []), complete(1, 2, [])]),
      ),
      "NO_CANDIDATES",
    );
  });

  it("accepts 1000 candidates and rejects 1001", () => {
    const thousandCandidates = Array.from({ length: 1000 }, (_, index) =>
      rawCandidate(String(index + 1)),
    );
    const oneThousandAndOneCandidates = [
      ...thousandCandidates,
      rawCandidate("1001"),
    ];

    const accepted = parseFixture(
      manifest([ref(1, 1)]),
      payload([complete(1, 1, thousandCandidates)]),
    );
    expect(accepted).toMatchObject({
      ok: true,
      value: { accounting: { candidateCount: 1000 } },
    });
    if (accepted.ok) {
      expect(accepted.value.regions[0].candidates).toHaveLength(1000);
    }

    expectFailure(
      parseFixture(
        manifest([ref(1, 1)]),
        payload([complete(1, 1, oneThousandAndOneCandidates)]),
      ),
      "TOO_MANY_CANDIDATES",
    );
  });

  it("rejects unsupported versions in both inputs", () => {
    expectFailure(
      parseFixture(
        { ...manifest([ref(1, 1)]), version: 2 },
        payload([complete(1, 1)]),
      ),
      "UNSUPPORTED_VERSION",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 1)]), payload([complete(1, 1)], 2)),
      "UNSUPPORTED_VERSION",
    );
  });

  it("rejects extra object keys at every input layer", () => {
    expectFailure(
      parseFixture(
        { ...manifest([ref(1, 1)]), provider: "not-accepted" },
        payload([complete(1, 1)]),
      ),
      "INVALID_MANIFEST",
    );
    expectFailure(
      parseFixture(
        {
          version: 1,
          pageCount: 1,
          regions: [{ ...ref(1, 1), provider: "not-accepted" }],
        },
        payload([complete(1, 1)]),
      ),
      "INVALID_MANIFEST",
    );
    expectFailure(
      parseFixture(manifest([ref(1, 1)]), {
        ...payload([complete(1, 1)]),
        provider: "not-accepted",
      }),
      "INVALID_PAYLOAD",
    );
    expectFailure(
      parseFixture(
        manifest([ref(1, 1)]),
        payload([{ ...complete(1, 1), provider: "not-accepted" }]),
      ),
      "INVALID_PAYLOAD",
    );
    expectFailure(
      parseFixture(
        manifest([ref(1, 1)]),
        payload([
          complete(1, 1, [{ ...rawCandidate(), provider: "not-accepted" }]),
        ]),
      ),
      "INVALID_PAYLOAD",
    );
  });

  it("rejects malformed primitive inputs without echoing payload data", () => {
    const validManifest = manifest([ref(1, 1)]);
    const validPayload = payload([complete(1, 1)]);

    expectFailure(parseFixture(null, validPayload), "INVALID_MANIFEST");
    expectFailure(parseFixture("manifest", validPayload), "INVALID_MANIFEST");
    expectFailure(parseFixture([], validPayload), "INVALID_MANIFEST");
    expectFailure(parseFixture(validManifest, null), "INVALID_PAYLOAD");
    expectFailure(parseFixture(validManifest, "payload"), "INVALID_PAYLOAD");
    expectFailure(parseFixture(validManifest, 1), "INVALID_PAYLOAD");

    const rawMarker = "raw-input-must-not-escape";
    const result = parseFixture(
      validManifest,
      payload([
        complete(1, 1, [
          rawCandidate("1"),
          rawCandidate(rawMarker, "invalid-date"),
        ]),
      ]),
    );
    expectFailure(result, "INVALID_AMOUNT_CENTS");
    expect(JSON.stringify(result)).not.toContain(rawMarker);
  });
});
