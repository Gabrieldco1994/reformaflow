import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionErrorCode,
} from "@reformaflow/domain";
import { ImportSessionError } from "./import-session.errors";

/** Keyset position of the recovery list. Signed, bound and short-lived; never a lookup. */
export type ImportListFilter = "active" | "applied";

export interface ImportListCursorBinding {
  readonly tenantId: string;
  readonly userId: string;
  readonly filter: ImportListFilter;
}

export interface ImportListPosition {
  /** Epoch ms of the sort column (`createdAt` for active, `closedAt` for applied). */
  readonly sortAtMs: number;
  readonly id: string;
}

export const IMPORT_LIST_CURSOR_TTL_MS = 900_000;
const MAX_CURSOR_LENGTH = 256;
const MIN_SECRET_LENGTH = 32;
const DEV_DEFAULT_SECRET = "dev-secret-change-me";
const KDF_INFO = "rf-import-session-cursor-v1";
const MAC_DOMAIN = "rf-import-session-cursor-v1/mac";
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const invalid = () =>
  new ImportSessionError(ImportSessionErrorCode.INVALID_INPUT);
const disabled = () =>
  new ImportSessionError(ImportSessionErrorCode.CAPABILITY_DISABLED);

/**
 * Derives the signing key from the EXISTING `JWT_SECRET` (HKDF, domain separated: the JWT
 * signing key itself is never used). In production a missing/empty/default/short (< 32
 * characters) secret closes the LIST with CAPABILITY_DISABLED: a gate, not a fallback. The
 * length minimum does not prove entropy; operations must vet the secret before activation.
 * Outside production the documented dev default applies, exactly like the auth module.
 */
export function deriveCursorKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const production = env["NODE_ENV"] === "production";
  const configured = env["JWT_SECRET"];
  const secret = configured ?? (production ? undefined : DEV_DEFAULT_SECRET);
  if (
    secret === undefined ||
    (production &&
      (secret.length < MIN_SECRET_LENGTH || secret === DEV_DEFAULT_SECRET)) ||
    secret.length === 0
  ) {
    throw disabled();
  }
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), KDF_INFO, 32));
}

const b64u = (buffer: Buffer): string => buffer.toString("base64url");
const canonical = (text: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const decoded = Buffer.from(text, "base64url");
  return decoded.toString("base64url") === text ? decoded : null;
};

function mac(
  key: Buffer,
  binding: ImportListCursorBinding,
  payload: string,
): Buffer {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        MAC_DOMAIN,
        binding.tenantId,
        binding.userId,
        binding.filter,
        payload,
      ]),
    )
    .digest();
}

export function signListCursor(
  key: Buffer,
  binding: ImportListCursorBinding,
  position: ImportListPosition,
  issuedAt: Date,
): string {
  const payload = b64u(
    Buffer.from(
      JSON.stringify([position.sortAtMs, position.id, issuedAt.getTime()]),
      "utf8",
    ),
  );
  return `${payload}.${b64u(mac(key, binding, payload))}`;
}

/**
 * Verifies format, size, signature (constant time), binding (tenant, user and filter are part
 * of the MAC), and age: `now - iat < 900 s`; a future `iat` is refused. Any defect is the same
 * INVALID_INPUT.
 */
export function verifyListCursor(
  key: Buffer,
  binding: ImportListCursorBinding,
  cursor: string,
  now: Date,
): ImportListPosition {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) throw invalid();
  const parts = cursor.split(".");
  if (parts.length !== 2) throw invalid();
  const [payload, signature] = parts as [string, string];
  const givenMac = canonical(signature);
  const payloadBytes = canonical(payload);
  if (!givenMac || !payloadBytes || givenMac.length !== 32) throw invalid();
  const expected = mac(key, binding, payload);
  if (!timingSafeEqual(givenMac, expected)) throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 3 ||
    !Number.isSafeInteger(decoded[0]) ||
    typeof decoded[1] !== "string" ||
    !ID.test(decoded[1]) ||
    !Number.isSafeInteger(decoded[2])
  ) {
    throw invalid();
  }
  const issuedAtMs = decoded[2] as number;
  const age = now.getTime() - issuedAtMs;
  if (age < 0 || age >= IMPORT_LIST_CURSOR_TTL_MS) throw invalid();
  return { sortAtMs: decoded[0] as number, id: decoded[1] };
}

export interface ImportPageCursorBinding {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly collection: "OBSERVATIONS" | "CANDIDATES";
  readonly lineId: string | null;
  readonly queryHash: string;
}

export interface ImportPagePosition {
  readonly kind: "OBSERVATION" | "EXPENSE" | "RECEIPT";
  readonly id: string;
}

// Accommodates a full 191-character public id, kind, timestamp and MAC.
const MAX_PAGE_CURSOR_LENGTH = 512;
function pageMac(
  key: Buffer,
  binding: ImportPageCursorBinding,
  payload: string,
): Buffer {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        `${MAC_DOMAIN}/page`,
        binding.tenantId,
        binding.userId,
        binding.sessionId,
        binding.revision,
        binding.collection,
        binding.lineId,
        binding.queryHash,
        payload,
      ]),
    )
    .digest();
}

export function signPageCursor(
  key: Buffer,
  binding: ImportPageCursorBinding,
  position: ImportPagePosition,
  now: Date,
): string {
  const payload = b64u(
    Buffer.from(
      JSON.stringify([position.kind, position.id, now.getTime()]),
      "utf8",
    ),
  );
  return `${payload}.${b64u(pageMac(key, binding, payload))}`;
}

export function verifyPageCursor(
  key: Buffer,
  binding: ImportPageCursorBinding,
  cursor: string,
  now: Date,
): ImportPagePosition {
  if (!cursor || cursor.length > MAX_PAGE_CURSOR_LENGTH) throw invalid();
  const parts = cursor.split(".");
  if (parts.length !== 2) throw invalid();
  const [payload, signature] = parts;
  const bytes = canonical(payload);
  const signatureBytes = canonical(signature);
  if (
    !bytes ||
    !signatureBytes ||
    signatureBytes.length !== 32 ||
    !timingSafeEqual(signatureBytes, pageMac(key, binding, payload))
  )
    throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalid();
    throw error;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !["OBSERVATION", "EXPENSE", "RECEIPT"].includes(value[0]) ||
    typeof value[1] !== "string" ||
    !ID.test(value[1]) ||
    typeof value[2] !== "number" ||
    !Number.isSafeInteger(value[2])
  )
    throw invalid();
  const kind: unknown = value[0];
  if (kind !== "OBSERVATION" && kind !== "EXPENSE" && kind !== "RECEIPT")
    throw invalid();
  if ((binding.collection === "OBSERVATIONS") !== (kind === "OBSERVATION"))
    throw invalid();
  const age = now.getTime() - value[2];
  if (age < 0 || age >= IMPORT_LIST_CURSOR_TTL_MS) throw invalid();
  return { kind, id: value[1] };
}
