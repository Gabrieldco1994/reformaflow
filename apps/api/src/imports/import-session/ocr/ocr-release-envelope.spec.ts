import { createHash, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const MODULE_PATH = "./ocr-release-envelope";
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETcR2VGRdx4NF62morqmSoG0zPfAw
hLBPUyJHlWdCYWrECgz8RP/DJzCtpsIUPVTf8J8TfRGw7xV2Cg3SgTeHFA==
-----END PUBLIC KEY-----`;
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgPc7I7VDN33d2GYOG
KmkhV7lJe9lzjVKVv76BU5mcu0OhRANCAARNxHZUZF3Hg0XraaiuqZKgbTM98DCE
sE9TIkeVZ0JhasQKDPxE/8MnMK2mwhQ9VN/wnxN9EbDvFXYKDdKBN4cU
-----END PRIVATE KEY-----`;
const P384_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEZpQ0zXPL5zmCjOlzxVpiko0GoSJLu/uc
9nnmrbVrceIZlBRBcVUJrNJX0iQphYv2GVDtRBBRjtSErwzZgMDKrZjzgpIAthvX
x7I5kB+t/xjz8v8EFdkCpKJA/ATdKUPl
-----END PUBLIC KEY-----`;
const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwauZT9KkHCqNgvn62E4P
dsJDHLxREsfw9OAFAxe+P7zPYQWI1DLwrhwdwJps2b7Ema6A/O4b9mU27RX47QNv
nP6HLu4aCy3STbCezqOSObW7fDIzyy1S0WbUYjTPNLm4efe/7u2x+HK1GSZf5h+K
2BmHMhL91QbzxRJa2jfAKTREJkIBM0rPq27bYGed3Yd7jcBreyV9p5X7pPWkFvFu
8wTQTd+bjR9CKmYDWWlPpye2oa+jJSwKBQ5bcw2HEFsYGRabcVerVvMHYNC4+HC7
44bRBOpznzGfsBtdo4T3DVRepVph/jx/9hA1J/iM9KhOFiuRqAD6IXNXmXygL7EG
+QIDAQAB
-----END PUBLIC KEY-----`;
const NOW = new Date("2026-10-14T12:00:00.000Z");

type ReleaseModule = Readonly<{
  parseOcrReleaseEnvelope(raw: string): unknown;
  verifyOcrReleaseEnvelope(
    envelope: unknown,
    runtime: Readonly<Record<string, unknown>>,
  ): unknown;
  verifyTrustedOcrP256Signature(
    input: Readonly<{
      keyId: string;
      payloadBytes: Buffer;
      signatureBase64: string;
    }>,
    runtime?: Readonly<Record<string, unknown>>,
  ): true;
}>;
type LoadedBoundary =
  | { readonly kind: "READY"; readonly value: ReleaseModule }
  | {
      readonly kind: "BOUNDARY_UNAVAILABLE";
      readonly code: "OCR_RELEASE_ENVELOPE_BOUNDARY_NOT_IMPLEMENTED";
    };

function loadReleaseBoundary(): LoadedBoundary {
  if (!existsSync(join(__dirname, "ocr-release-envelope.ts")))
    return {
      kind: "BOUNDARY_UNAVAILABLE",
      code: "OCR_RELEASE_ENVELOPE_BOUNDARY_NOT_IMPLEMENTED",
    };
  const loaded = require(MODULE_PATH) as Partial<ReleaseModule>;
  if (
    typeof loaded.parseOcrReleaseEnvelope !== "function" ||
    typeof loaded.verifyOcrReleaseEnvelope !== "function" ||
    typeof loaded.verifyTrustedOcrP256Signature !== "function"
  ) {
    return {
      kind: "BOUNDARY_UNAVAILABLE",
      code: "OCR_RELEASE_ENVELOPE_BOUNDARY_NOT_IMPLEMENTED",
    };
  }
  return { kind: "READY", value: loaded as ReleaseModule };
}

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function signedFixture(
  overrides: Readonly<Record<string, unknown>> = {},
  payloadBytes?: Buffer,
) {
  const payload =
    payloadBytes ??
    Buffer.from(
      JSON.stringify({
        version: 1,
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        imageDigest: `sha256:${"c".repeat(64)}`,
        applicationEntrypointPath: "/app/apps/api/dist/main.js",
        executableSha256: sha256("api-executable"),
        runtimeSubjectArtifactSha256: sha256("runtime-subject-artifact"),
        workflow: {
          name: "ocr-qualification.yml",
          sha: "d".repeat(40),
          runId: 719,
          attempt: 1,
        },
        policySha256: sha256("policy"),
        corpusSha256: sha256("corpus"),
        rawEvidenceSha256: sha256("raw-evidence"),
        reportSha256: sha256("report"),
        activationSubjectSha256: sha256("activation-subject"),
        provider: {
          id: "GOOGLE_VERTEX_AI",
          model: "gemini-2.5-flash",
          region: "southamerica-east1",
        },
        verdict: "PASS",
        validFrom: "2026-10-14T11:00:00.000Z",
        validThrough: "2026-10-14T13:00:00.000Z",
        ...overrides,
      }),
    );
  return {
    schemaVersion: 1,
    payloadBase64: payload.toString("base64"),
    signature: {
      keyId: "qa-p256-2026-10",
      algorithm: "EC_SIGN_P256_SHA256",
      valueBase64: sign("sha256", payload, PRIVATE_KEY).toString("base64"),
    },
  };
}

const runtime = Object.freeze({
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  imageDigest: `sha256:${"c".repeat(64)}`,
  applicationEntrypointPath: "/app/apps/api/dist/main.js",
  executableSha256: sha256("api-executable"),
  runtimeSubjectArtifactSha256: sha256("runtime-subject-artifact"),
  activationSubjectSha256: sha256("activation-subject"),
  allowedWorkflowShas: ["d".repeat(40)],
  now: NOW,
  embeddedTrustBundle: Object.freeze({
    keys: [
      {
        keyId: "qa-p256-2026-10",
        algorithm: "EC_SIGN_P256_SHA256",
        publicKeyPem: PUBLIC_KEY,
      },
    ],
  }),
});

function requireReleaseBoundary(): ReleaseModule {
  const boundary = loadReleaseBoundary();
  expect(boundary).toMatchObject({ kind: "READY" });
  if (boundary.kind !== "READY") throw new Error(boundary.code);
  return boundary.value;
}

describe("production OCR release envelope", () => {
  it("parses an envelope structurally without granting OCR authority", () => {
    const boundary = requireReleaseBoundary();
    const parsed = boundary.parseOcrReleaseEnvelope(
      JSON.stringify({
        ...signedFixture(),
        signature: {
          keyId: "qa-p256-2026-10",
          algorithm: "EC_SIGN_P256_SHA256",
          valueBase64: Buffer.from("random-untrusted-signature").toString(
            "base64",
          ),
        },
      }),
    );

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      trust: "UNTRUSTED",
    });
    expect(parsed).not.toHaveProperty("verified", true);
  });

  it("verifies the exact payload bytes with the embedded public key", () => {
    const boundary = requireReleaseBoundary();
    const parsed = boundary.parseOcrReleaseEnvelope(
      JSON.stringify(signedFixture()),
    );

    expect(boundary.verifyOcrReleaseEnvelope(parsed, runtime)).toMatchObject({
      kind: "VERIFIED",
      algorithm: "EC_SIGN_P256_SHA256",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
    });
  });

  it("verifies detached canonical bytes only with an admitted trust key", () => {
    const boundary = requireReleaseBoundary();
    const payloadBytes = Buffer.from(
      '{"candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidenceSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","kind":"REFORMAFLOW_OCR_QUALITY_CLOSURE"}',
    );
    const signatureBase64 = sign("sha256", payloadBytes, PRIVATE_KEY).toString(
      "base64",
    );

    expect(
      boundary.verifyTrustedOcrP256Signature(
        {
          keyId: "qa-p256-2026-10",
          payloadBytes,
          signatureBase64,
        },
        runtime,
      ),
    ).toBe(true);
    expect(() =>
      boundary.verifyTrustedOcrP256Signature({
        keyId: "qa-p256-2026-10",
        payloadBytes,
        signatureBase64,
      }),
    ).toThrow("OCR_ATTESTATION_KEY_NOT_ALLOWED");
  });

  it.each([
    ["payload byte", "OCR_ATTESTATION_SIGNATURE_INVALID"],
    ["signature byte", "OCR_ATTESTATION_SIGNATURE_INVALID"],
    ["key ID", "OCR_ATTESTATION_KEY_NOT_ALLOWED"],
    ["algorithm", "OCR_ATTESTATION_SCHEMA_INVALID"],
    ["workflow SHA", "OCR_ATTESTATION_WORKFLOW_NOT_ALLOWED"],
    ["release subject", "OCR_ATTESTATION_SUBJECT_MISMATCH"],
    ["image digest", "OCR_ATTESTATION_SUBJECT_MISMATCH"],
    ["entrypoint path", "OCR_ATTESTATION_SUBJECT_MISMATCH"],
    ["executable SHA", "OCR_ATTESTATION_SUBJECT_MISMATCH"],
    ["runtime subject artifact", "OCR_ATTESTATION_SUBJECT_MISMATCH"],
    ["expiry", "OCR_ATTESTATION_EXPIRED"],
    ["GAPS verdict", "OCR_ATTESTATION_NOT_PASS"],
  ] as const)("rejects altered %s with %s", (mutation, expectedCode) => {
    const boundary = requireReleaseBoundary();
    const fixture = signedFixture(
      mutation === "workflow SHA"
        ? { workflow: { name: "ocr-qualification.yml", sha: "e".repeat(40) } }
        : mutation === "release subject"
          ? { commitSha: "f".repeat(40) }
          : mutation === "image digest"
            ? { imageDigest: `sha256:${"f".repeat(64)}` }
            : mutation === "entrypoint path"
              ? { applicationEntrypointPath: "/app/dist/other.js" }
              : mutation === "executable SHA"
                ? { executableSha256: sha256("different-executable") }
                : mutation === "runtime subject artifact"
                  ? {
                      runtimeSubjectArtifactSha256: sha256(
                        "different-runtime-subject",
                      ),
                    }
                  : mutation === "expiry"
                    ? { validThrough: "2026-10-14T10:59:59.000Z" }
                    : mutation === "GAPS verdict"
                      ? { verdict: "GAPS" }
                      : {},
    );
    const mutated =
      mutation === "payload byte"
        ? {
            ...fixture,
            payloadBase64: Buffer.from(
              `${Buffer.from(fixture.payloadBase64, "base64").toString()} `,
            ).toString("base64"),
          }
        : mutation === "signature byte"
          ? {
              ...fixture,
              signature: {
                ...fixture.signature,
                valueBase64:
                  Buffer.from("altered-signature").toString("base64"),
              },
            }
          : mutation === "key ID"
            ? {
                ...fixture,
                signature: { ...fixture.signature, keyId: "attacker-key" },
              }
            : mutation === "algorithm"
              ? {
                  ...fixture,
                  signature: {
                    ...fixture.signature,
                    algorithm: "RSA_PSS_SHA256",
                  },
                }
              : fixture;
    const parsed = boundary.parseOcrReleaseEnvelope(JSON.stringify(mutated));

    expect(() => boundary.verifyOcrReleaseEnvelope(parsed, runtime)).toThrow(
      expectedCode,
    );
  });

  it("does not accept a caller supplied trust bundle", () => {
    const boundary = requireReleaseBoundary();
    const attacker = signedFixture();
    const parsed = boundary.parseOcrReleaseEnvelope(JSON.stringify(attacker));

    expect(() =>
      boundary.verifyOcrReleaseEnvelope(parsed, {
        ...runtime,
        embeddedTrustBundle: { keys: [] },
        OCR_RELEASE_TRUST_JSON: JSON.stringify({
          keys: runtime.embeddedTrustBundle.keys,
        }),
      }),
    ).toThrow("OCR_ATTESTATION_KEY_NOT_ALLOWED");
  });

  it.each([
    ["RSA/PSS key", RSA_PUBLIC_KEY],
    ["wrong elliptic curve", P384_PUBLIC_KEY],
  ] as const)("rejects a trusted key using %s", (_label, publicKeyPem) => {
    const boundary = requireReleaseBoundary();
    const parsed = boundary.parseOcrReleaseEnvelope(
      JSON.stringify(signedFixture()),
    );

    expect(() =>
      boundary.verifyOcrReleaseEnvelope(parsed, {
        ...runtime,
        embeddedTrustBundle: {
          keys: [
            {
              keyId: "qa-p256-2026-10",
              algorithm: "EC_SIGN_P256_SHA256",
              publicKeyPem,
            },
          ],
        },
      }),
    ).toThrow("OCR_ATTESTATION_KEY_INVALID");
  });

  it("rejects a raw r||s signature instead of ASN.1 DER", () => {
    const boundary = requireReleaseBoundary();
    const fixture = signedFixture();
    const rawSignature = Buffer.alloc(64, 0x71);
    const parsed = boundary.parseOcrReleaseEnvelope(
      JSON.stringify({
        ...fixture,
        signature: {
          ...fixture.signature,
          valueBase64: rawSignature.toString("base64"),
        },
      }),
    );

    expect(() => boundary.verifyOcrReleaseEnvelope(parsed, runtime)).toThrow(
      "OCR_ATTESTATION_SIGNATURE_INVALID",
    );
  });

  it("rejects a mismatched activation subject binding", () => {
    const boundary = requireReleaseBoundary();
    const parsed = boundary.parseOcrReleaseEnvelope(
      JSON.stringify(signedFixture()),
    );

    expect(() =>
      boundary.verifyOcrReleaseEnvelope(parsed, {
        ...runtime,
        activationSubjectSha256: sha256("different-activation-subject"),
      }),
    ).toThrow("OCR_ATTESTATION_SUBJECT_MISMATCH");
  });

  it("rejects duplicate JSON keys before signature authority is considered", () => {
    const boundary = requireReleaseBoundary();
    const fixture = signedFixture();
    const raw = `{"schemaVersion":1,"schemaVersion":1,"payloadBase64":${JSON.stringify(fixture.payloadBase64)},"signature":${JSON.stringify(fixture.signature)}}`;

    expect(() => boundary.parseOcrReleaseEnvelope(raw)).toThrow(
      "OCR_ATTESTATION_SCHEMA_INVALID",
    );
  });
});
