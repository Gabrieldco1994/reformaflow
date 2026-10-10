require("../../../../../../scripts/test-db-env.cjs");

import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { canonicalVaultFixture } from "../../../test-utils/import-session-vault-harness";
import {
  ART,
  REF,
  PDF,
  fixture,
  bounded,
  outcome,
  readAll,
} from "../../../test-utils/vault-foundation-harness";

describe("artifact reader owns exactly one native FileHandle close", () => {
  it.each(["complete", "consumer-error", "shutdown"] as const)(
    "%s closes the actual handle once and does not close the borrowed lock",
    async (mode) => {
      const f = await fixture();
      const os = await canonicalVaultFixture(f.root);
      let open: jest.SpyInstance | undefined;
      let close: jest.SpyInstance | undefined;
      let observed: FileHandle | undefined;
      try {
        const gate = os.createGate(f.db, f.clock);
        await bounded(gate.boot.settled);
        expect(gate.boot.state()).toBe("ON");
        await f.seedArtifact();
        await f.seedRef(REF, {
          state: "ATTACHED",
          artifactId: ART,
          reservedBytes: 0,
        });
        await f.writeBlob();
        const nativeOpen = fs.open.bind(fs);
        open = jest.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await nativeOpen(...args);
          if (String(args[0]) === join(f.root, `t/${REF}/g2/blob`)) {
            observed = handle;
            close = jest.spyOn(handle, "close");
          }
          return handle;
        });
        const entered = f.gate();
        const consumerError = new Error("consumer-cancel");
        const reading = outcome(
          f.track(
            gate.storage.withArtifactReader(
              f.readCapture(),
              f.recheckRead,
              async (source) => {
                entered.release();
                if (mode === "consumer-error") throw consumerError;
                if (mode === "shutdown")
                  return new Promise<Buffer>((_resolve, reject) => {
                    source.once("error", reject);
                  });
                return readAll(source);
              },
            ),
          ),
        );
        await bounded(entered.promise);
        if (mode === "shutdown")
          expect(await bounded(gate.shutdown())).toBe("DRAINED");
        const result = await bounded(reading);
        if (mode === "complete")
          expect(result).toEqual({ ok: true, value: PDF });
        else {
          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("reader unexpectedly succeeded");
          if (mode === "consumer-error")
            expect(result.error).toBe(consumerError);
          else expect(result.error).toMatchObject({ kind: "FENCED" });
        }
        expect(close).toHaveBeenCalledTimes(1);
        expect(observed?.fd).toBe(-1);
        expect(await gate.registry.abortAndDrain(`A:${ART}`, 0)).toBe(
          "DRAINED",
        );
        expect(os.borrowed.fd).toBeGreaterThanOrEqual(3);
        expect(await fs.readFile(join(f.root, `t/${REF}/g2/blob`))).toEqual(
          PDF,
        );
      } finally {
        open?.mockRestore();
        close?.mockRestore();
        await f.finish();
        await os.close();
      }
    },
  );
});
