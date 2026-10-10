import childProcess = require("node:child_process");
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os = require("node:os");
import { MODULE_METADATA } from "@nestjs/common/constants";
import type { DocumentExtractionV1 } from "../credit-card/parsers/types";
import type { X2NativeConfig } from "../credit-card/parsers/statement-document.runner";
import { ImportSessionModule } from "../imports/import-session/import-session.module";
import { ImportRawExecutions } from "../imports/import-session/import-session.raw-executions";
import type {
  ImportSessionClock,
  ImportSessionCapability,
} from "../imports/import-session/import-session.capability";
import {
  IMPORT_VAULT_GATE,
  ImportVaultGate,
} from "../imports/import-session/vault/vault-state";
import { seedImportWorld, seedSession } from "./import-session-harness";
import {
  bootVaultApp,
  createVaultTestDatabase,
  fileSeed,
  reserve,
  putContent,
  pdfBytes,
  UI_HEADERS,
  CANONICAL_VAULT,
} from "./import-session-vault-harness";

export const RAW_TEST_CONFIG: Readonly<X2NativeConfig> = Object.freeze({
  runtimeRoot: "/synthetic-x2",
  runtimeSeal: "a".repeat(64),
  workerUid: 65532,
  workerGid: 65532,
  memoryBytes: 67108864n,
  cpuQuotaUs: 100000n,
  cpuPeriodUs: 100000n,
  cpuBudgetNs: 1000000000n,
  cpuPollMs: 20,
  pidsMax: 8,
  cleanupMs: 100,
});
export const RAW_DOCUMENT: DocumentExtractionV1 = {
  version: 1,
  parserVersion: "card-local-pdf-v1",
  documentKind: "INVOICE",
  invoiceDueMonth: null,
  metrics: {
    pages: 1,
    rows: 3,
    expandedBytes: 0,
    archiveEntries: 0,
    imagePixels: 0,
    frames: 0,
  },
  occurrences: [0, 1, 2].map((ordinal) => ({
    reference: `pdf:page:1:line:${ordinal + 1}`,
    sourceOrdinal: ordinal,
    section: "CURRENT",
    raw: {
      date: null,
      description: "SYNTHETIC",
      amount: "12,34",
      installment: null,
    },
    cycle: null,
    dateOnly: ordinal === 2 ? null : "2026-06-22",
    merchant: "SYNTHETIC",
    amountCents: 1234,
    amountMeaning: "UNKNOWN",
    installmentCount: null,
    installmentIndex: null,
    fitId: null,
    identityOrdinal: ordinal === 2 ? null : ordinal,
  })),
  diagnostics: [],
};

// A real subprocess peer implements only the synthetic N1 exchange, never a parser or launcher.
const PEER = String.raw`
const net = require("node:net"), crypto = require("node:crypto");
const control = new net.Socket({fd:3, readable:true, writable:true});
const nonce=Buffer.alloc(16,7); let profile=0, pending=Buffer.alloc(0), document;
const frame=(kind,p,body)=>{const h=Buffer.alloc(12);h.write("X2N1");h[4]=kind;h[5]=p;h.writeUInt32BE(body.length,8);return Buffer.concat([h,body]);};
let ended=false;
const terminal=(kind,body,code,result)=>{
 if(ended)return; ended=true;
 let left=2;
 const finish=()=>{if(--left===0){if(process.connected)process.disconnect();process.exitCode=code;}};
 process.stdout.end(result ? frame(5,profile,Buffer.from(JSON.stringify(result))) : undefined,finish);
 control.end(frame(kind,profile,body),finish);
};
const fail=(code=25,cleanup=1)=>{const b=Buffer.alloc(12);b.writeUInt16BE(code);b.writeUInt16BE(cleanup,8);terminal(7,b,cleanup===2?27:code);};
control.on("data",chunk=>{
 if(chunk[4]===8){process.send({kind:"cancel"});fail();}
});
process.stdin.on("data",chunk=>{
 pending=Buffer.concat([pending,chunk]);
 while(pending.length>=12 && pending.length>=12+pending.readUInt32BE(8)){
  const n=pending.readUInt32BE(8),kind=pending[4];profile=pending[5];
  const b=pending.subarray(12,12+n);pending=pending.subarray(12+n);
  if(kind===2)control.write(frame(3,profile,nonce));
  else if(kind===4)document=Buffer.from(b);
  else throw Error("Unexpected synthetic frame");
 }
});
let settings;
const complete=()=>{
 if(!document || !settings || ended)return;
 const b=settings.behavior;
 if(b==="hold")return;
 if(b==="quarantine")return fail(27,2);
 if(b==="unconfirmed"){ended=true;control.destroy();process.stdout.end();process.disconnect();process.exitCode=24;return;}
 if(b==="failure")return fail(28,1);
 terminal(6,nonce,0,settings.dto);
};
process.stdin.on("end",()=>{
 if(document)process.send({kind:"eof",sha:crypto.createHash("sha256").update(document).digest("hex"),bytes:document.length,profile});
 complete();
});
process.on("message",message=>{
 if(message.kind==="settings"){settings=message;control.write(frame(1,0,nonce));}
 if(message.kind==="release"){settings.behavior="success";complete();}
});
`;

export type PeerBehavior =
  | "success"
  | "hold"
  | "quarantine"
  | "unconfirmed"
  | "failure";
export function nativePeers() {
  const actual = childProcess.spawn;
  const children: childProcess.ChildProcess[] = [];
  const events: unknown[] = [];
  const eofWaiters: Array<() => void> = [];
  let behavior: PeerBehavior = "success";
  let dto = RAW_DOCUMENT;
  const configuredEvidenceDir = process.env.RAW_CALLER_TEST_EVIDENCE_DIR;
  const evidenceDir =
    configuredEvidenceDir ??
    mkdtempSync(join(os.tmpdir(), "reformaflow-raw-peer-"));
  if (!configuredEvidenceDir) chmodSync(evidenceDir, 0o700);
  const platform = jest.spyOn(os, "platform").mockReturnValue("linux");
  const spawn = jest
    .spyOn(childProcess, "spawn")
    .mockImplementation((file, args, options) => {
      if (file !== "/usr/local/libexec/reformaflow-x2")
        throw new Error("Unexpected subprocess in RAW test");
      const id = randomUUID();
      const argv = [
        "--require",
        resolve(__dirname, "../../../../scripts/test-db-env.cjs"),
        "-e",
        PEER,
      ];
      const child = actual(process.execPath, argv, {
        env: { TZ: "UTC", TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
        stdio: ["pipe", "pipe", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      const captured: unknown[] = [];
      child.on("message", (message) => {
        events.push(message);
        captured.push(message);
        if (
          typeof message === "object" &&
          message !== null &&
          "kind" in message &&
          message.kind === "eof"
        )
          eofWaiters.splice(0).forEach((resolve) => resolve());
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      writeFileSync(
        join(evidenceDir, `${id}-argv.json`),
        JSON.stringify({
          executable: process.execPath,
          argv,
          requested: { file, args, options },
          pid: child.pid,
        }),
        { mode: 0o600 },
      );
      child.on("close", (code, signal) =>
        writeFileSync(
          join(evidenceDir, `${id}-exit.json`),
          JSON.stringify({ code, signal, stderr, events: captured }),
          { mode: 0o600 },
        ),
      );
      child.send({ kind: "settings", behavior, dto });
      return child;
    });
  return {
    spawn,
    events,
    children,
    setBehavior(value: PeerBehavior) {
      behavior = value;
    },
    setDocument(value: DocumentExtractionV1) {
      dto = value;
    },
    eof: () => new Promise<void>((resolve) => eofWaiters.push(resolve)),
    release() {
      for (const child of children)
        if (child.connected) child.send({ kind: "release" });
    },
    async close() {
      spawn.mockRestore();
      platform.mockRestore();
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        await new Promise<void>((resolve, reject) => {
          child.once("close", () => resolve());
          child.once("error", reject);
          if (child.connected) child.send({ kind: "release" });
        });
      }
      if (!configuredEvidenceDir)
        rmSync(evidenceDir, { recursive: true, force: true });
    },
  };
}

export async function rawWorld(
  config: Readonly<X2NativeConfig> | null = RAW_TEST_CONFIG,
) {
  const database = await createVaultTestDatabase();
  const providers: Array<{ provide?: unknown }> = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    ImportSessionModule,
  );
  const token = providers
    .map((p) => p.provide)
    .find(
      (p) =>
        typeof p === "symbol" && p.description === "IMPORT_X2_NATIVE_CONFIG",
    );
  const api = await bootVaultApp(database.setup, {
    writes: true,
    vault: CANONICAL_VAULT,
    overrides: [
      {
        token: typeof token === "symbol" ? token : Symbol("absent-raw-config"),
        value: config,
      },
    ],
  });
  const db = database.setup;
  const world = await seedImportWorld(db, `raw-own-${randomUUID()}`);
  const authToken = await api.tokenFor(world.users.owner);
  const gate = api.app.get<ImportVaultGate>(IMPORT_VAULT_GATE);
  return {
    api,
    db,
    world,
    token: authToken,
    gate,
    async upload() {
      const session = await seedSession(db, world);
      const bytes = pdfBytes(1000);
      const file = fileSeed({
        fileName: "synthetic.pdf",
        mime: "application/pdf",
        declaredBytes: bytes.length,
      });
      const reserved = await reserve(api, authToken, session.id, [file]);
      expect(reserved.status).toBe(200);
      const result = await putContent(api, session.id, file.id, {
        token: authToken,
        body: bytes,
      });
      expect(result.status).toBe(200);
      const ref = await db.importSessionArtifact.findUniqueOrThrow({
        where: { id: file.id },
      });
      if (!ref.artifactId) throw new Error("PUT did not attach a RAW artifact");
      const artifact = await db.importArtifact.findUniqueOrThrow({
        where: { id: ref.artifactId },
      });
      return {
        session,
        ref,
        artifact,
        bytes,
        revision: result.json.revision as number,
      };
    },
    analyze(f: {
      session: { id: string };
      ref: { id: string };
      revision: number;
    }) {
      return api.call(
        "POST",
        `/import-sessions/${f.session.id}/attachments/${f.ref.id}/analyze`,
        {
          token: authToken,
          headers: UI_HEADERS,
          body: { expectedRevision: f.revision },
        },
      );
    },
    async close() {
      await api.close();
      await database.close();
    },
  };
}

export const rawSha = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const fixtureExecutions = new WeakMap<ImportVaultGate, ImportRawExecutions>();
export function rawTestDependencies(
  gate: ImportVaultGate,
  clock: ImportSessionClock,
  capability: ImportSessionCapability,
): [ImportVaultGate, ImportRawExecutions] {
  let raw = fixtureExecutions.get(gate);
  if (!raw) {
    raw = new ImportRawExecutions(gate, clock, capability, null);
    fixtureExecutions.set(gate, raw);
  }
  return [gate, raw];
}
