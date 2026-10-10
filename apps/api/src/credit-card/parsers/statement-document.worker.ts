import { Readable, Writable } from "node:stream";
import { extractCardStatementBinaryDocument } from "./statement-document";
import {
  BinaryDocumentExtractionError,
  DocumentExtractionError,
} from "./types";
import { X2FrameReader, X2_WIRE, x2Frame } from "./statement-document.runner";

const REASONS = [
  "PASSWORD_PROTECTED",
  "NO_TEXT_LAYER",
  "UNSUPPORTED_LAYOUT",
  "MULTIPLE_SHEETS",
  "UNSUPPORTED_CONTAINER",
  "CORRUPT_DOCUMENT",
] as const;

export function runX2Worker(input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    let profile = 0;
    let document: Buffer | null = null;
    let invalid = false;
    let terminal = false;
    const finish = (frame: Buffer) => {
      if (terminal) return;
      terminal = true;
      try {
        output.end(frame);
      } catch (error) {
        reject(error);
      }
    };
    const writeError = (error: unknown) => {
      if (terminal) return;
      const fields = Buffer.alloc(12);
      fields.writeUInt16BE(
        error instanceof DocumentExtractionError ? 10 : 24,
        0,
      );
      if (error instanceof DocumentExtractionError) {
        const codes = [
          "INVALID_INPUT",
          "UNSUPPORTED_DOCUMENT",
          "LIMIT_EXCEEDED",
          "INVALID_RESULT",
        ];
        fields.writeUInt16BE(codes.indexOf(error.code) + 1, 4);
        if (error instanceof BinaryDocumentExtractionError)
          fields.writeUInt16BE(REASONS.indexOf(error.reason) + 1, 6);
      }
      finish(x2Frame(X2_WIRE.error, profile, fields));
    };
    output.once("finish", resolve);
    output.once("error", (error) => {
      terminal = true;
      reject(error);
    });
    const reader = new X2FrameReader(
      (kind, p, length) =>
        !profile
          ? kind === X2_WIRE.workerInit && p >= 1 && p <= 3 && length === 0
          : document === null &&
            kind === X2_WIRE.document &&
            p === profile &&
            length > 0 &&
            length <= X2_WIRE.maxBytes,
      (frame) => {
        if (!profile) {
          if (frame.kind !== X2_WIRE.workerInit) throw new Error("X2_PROTOCOL");
          profile = frame.profile;
          output.write(x2Frame(X2_WIRE.workerReady, profile, Buffer.alloc(0)));
        } else {
          if (
            document ||
            frame.kind !== X2_WIRE.document ||
            frame.profile !== profile
          )
            throw new Error("X2_PROTOCOL");
          document = frame.body;
        }
      },
    );
    input.on("data", (chunk: Buffer) => {
      if (invalid) return;
      try {
        reader.push(chunk);
      } catch {
        invalid = true;
      }
    });
    input.once("error", () => {
      invalid = true;
      writeError(new Error("X2_INPUT"));
    });
    input.once("end", () => {
      if (terminal || output.writableEnded) return;
      if (invalid || !reader.complete || !profile || !document) {
        writeError(new Error("X2_PROTOCOL"));
        return;
      }
      const common = {
        version: 1 as const,
        context: "CARD_INVOICE" as const,
        bytes: document,
      };
      const request =
        profile === 1
          ? {
              ...common,
              format: "PDF" as const,
              profile: "PDF_TEXT_CARD" as const,
            }
          : profile === 2
            ? {
                ...common,
                format: "XLS" as const,
                profile: "XLS_CARD" as const,
              }
            : {
                ...common,
                format: "XLSX" as const,
                profile: "XLSX_CARD" as const,
              };
      void extractCardStatementBinaryDocument(request)
        .then((result) => {
          if (terminal) return;
          const bytes = Buffer.from(JSON.stringify(result), "utf8");
          if (!bytes.length || bytes.length > X2_WIRE.maxBytes) {
            writeError(new DocumentExtractionError("INVALID_RESULT"));
            return;
          }
          finish(x2Frame(X2_WIRE.result, profile, bytes));
        }, writeError)
        .catch(writeError);
    });
  });
}

if (require.main === module) {
  void runX2Worker(process.stdin, process.stdout).catch(() => {
    process.exitCode = 24;
  });
}
