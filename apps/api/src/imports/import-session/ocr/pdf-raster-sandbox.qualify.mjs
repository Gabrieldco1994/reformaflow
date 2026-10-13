import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sandboxModule from "./pdf-raster-sandbox.js";

const {
  buildLinuxSandboxSpawn,
  LinuxPdfSandboxProcessRunner,
  PdfRasterSandbox,
} = sandboxModule;
const here = dirname(fileURLToPath(import.meta.url));
const runRoot = "/tmp/reformaflow-pdf-qualification";
const MIME = "application/pdf";
const MEMORY_GATE_BYTES = 512 * 1024 * 1024;
let peakRssBytes = 0;

function pdf({ pages = 1, image = true, text = true, metadata = false } = {}) {
  const body =
    (text ? "BT /F1 12 Tf 50 750 Td (Synthetic statement) Tj ET" : "") +
    (image ? "\nq 120 0 0 120 50 500 cm /Im1 Do Q" : "");
  const objects = [
    metadata
      ? "<< /Type /Catalog /Pages 2 0 R /Metadata 9 0 R >>"
      : "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${6 + i} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream",
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  if (metadata) {
    while (objects.length < 8) objects.push("null");
    const secret = "<x:xmpmeta>SECRET_METADATA_MUST_NOT_SURVIVE</x:xmpmeta>";
    objects.push(
      `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(secret)} >>\nstream\n${secret}\nendstream`,
    );
  }
  let result = "%PDF-1.7\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

function assert(condition, label) {
  if (!condition) throw new Error(`qualification failed: ${label}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pngChunkTypes(bytes) {
  const types = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    types.push(type);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return types;
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert(error?.code === code, `expected ${code}, received ${error?.code}`);
    return;
  }
  throw new Error(`qualification failed: expected ${code}`);
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString("ascii")));
    child.stderr.on("data", (chunk) => (output += chunk.toString("ascii")));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `qualification subprocess failed (${code}): ${output.slice(0, 200)}`,
            ),
          ),
    );
  });
}

async function rssBytes() {
  let total = 0;
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = await readFile(`/proc/${entry}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (rss) total += Number(rss[1]) * 1024;
    } catch {
      // Process exited between listing and read.
    }
  }
  return total;
}

async function qualifyProfile() {
  const probe = join(here, "pdf-raster-sandbox.probe.sh");
  const directory = join(runRoot, "profile");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const server = createServer();
  await promisify(server.listen.bind(server))(0, "127.0.0.1");
  const address = server.address();
  assert(address && typeof address === "object", "probe server address");
  await writeFile(join(directory, "probe-network"), String(address.port));
  process.env.GEMINI_API_KEY = "qualification-secret";
  process.env.DATABASE_URL = "file:/private/qualification.db";
  const launch = buildLinuxSandboxSpawn(directory, probe);
  await run(launch.command, [...launch.args], launch.options);
  await promisify(server.close.bind(server))();
  delete process.env.GEMINI_API_KEY;
  delete process.env.DATABASE_URL;
  await rm(directory, { recursive: true, force: true });
}

async function main() {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { mode: 0o700 });
  const monitor = setInterval(async () => {
    peakRssBytes = Math.max(peakRssBytes, await rssBytes());
  }, 10);

  const sandbox = new PdfRasterSandbox(undefined, runRoot);
  const scanned = await sandbox.rasterize({
    mimeType: MIME,
    bytes: pdf({ image: true, text: false }),
  });
  const document = pdf({ pages: 2, image: true, metadata: true });
  const first = await sandbox.rasterize({ mimeType: MIME, bytes: document });
  const second = await sandbox.rasterize({ mimeType: MIME, bytes: document });
  assert(first.pages.length === 2, "mixed/scanned pages admitted");
  assert(scanned.pages.length === 1, "scanned-only page admitted");
  assert(
    first.pages.every(
      (page, index) => sha256(page.png) === sha256(second.pages[index].png),
    ),
    "deterministic raster bytes",
  );
  assert(
    first.pages.every((page) =>
      pngChunkTypes(page.png).every((type) =>
        ["IHDR", "PLTE", "IDAT", "IEND", "tRNS"].includes(type),
      ),
    ),
    "metadata stripped",
  );
  assert(
    first.pages.every(
      (page) => !page.png.includes(Buffer.from("SECRET_METADATA")),
    ),
    "source metadata absent",
  );
  console.log("qualification phase: raster admission");

  await expectCode(
    sandbox.rasterize({ mimeType: MIME, bytes: pdf({ pages: 11 }) }),
    "PAGE_LIMIT_EXCEEDED",
  );
  await expectCode(
    sandbox.rasterize({
      mimeType: MIME,
      bytes: Buffer.concat([pdf(), Buffer.from("PK\u0003\u0004polyglot")]),
    }),
    "INVALID_DOCUMENT",
  );
  await expectCode(
    sandbox.rasterize({
      mimeType: MIME,
      bytes: Buffer.from("%PDF-1.7\n%%EOF\n"),
    }),
    "MALFORMED_PDF",
  );
  console.log("qualification phase: structural rejection");

  const fixtureDirectory = join(runRoot, "fixtures");
  await mkdir(fixtureDirectory, { mode: 0o700 });
  const base = join(fixtureDirectory, "base.pdf");
  const encrypted = join(fixtureDirectory, "encrypted.pdf");
  const attachment = join(fixtureDirectory, "attachment.pdf");
  const payload = join(fixtureDirectory, "payload.txt");
  await writeFile(base, pdf());
  await writeFile(payload, "synthetic");
  await run("/usr/bin/qpdf", [
    "--encrypt",
    "user",
    "owner",
    "256",
    "--",
    base,
    encrypted,
  ]);
  await run("/usr/bin/qpdf", [
    base,
    "--add-attachment",
    payload,
    "--",
    attachment,
  ]);
  await expectCode(
    sandbox.rasterize({ mimeType: MIME, bytes: await readFile(encrypted) }),
    "ENCRYPTED_PDF",
  );
  await expectCode(
    sandbox.rasterize({ mimeType: MIME, bytes: await readFile(attachment) }),
    "EMBEDDED_FILE",
  );
  await rm(fixtureDirectory, { recursive: true, force: true });
  console.log("qualification phase: encryption and attachment rejection");

  await qualifyProfile();
  console.log("qualification phase: network, secrets and descriptors");

  let started;
  const childStarted = new Promise((resolve) => {
    started = resolve;
  });
  const hangingRunner = new LinuxPdfSandboxProcessRunner(
    join(here, "pdf-raster-sandbox.probe.sh"),
  );
  const abortRunner = {
    async execute(run) {
      await writeFile(join(run.runDirectory, "probe-hang"), "1");
      started();
      return hangingRunner.execute(run);
    },
  };
  const abortSandbox = new PdfRasterSandbox(abortRunner, runRoot);
  const abort = new AbortController();
  const pending = abortSandbox.rasterize({
    mimeType: MIME,
    bytes: pdf(),
    signal: abort.signal,
  });
  await childStarted;
  await new Promise((resolve) => setTimeout(resolve, 100));
  abort.abort();
  await expectCode(pending, "ABORTED");
  console.log("qualification phase: process-group abort");

  clearInterval(monitor);
  peakRssBytes = Math.max(peakRssBytes, await rssBytes());
  assert(peakRssBytes <= MEMORY_GATE_BYTES, "512 MiB peak RSS gate");
  assert((await readdir(runRoot)).length === 0, "all run directories cleaned");
  await rm(runRoot, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      qualified: true,
      pages: first.pages.length,
      deterministic: true,
      metadataStripped: true,
      networkIsolated: true,
      secretsIsolated: true,
      inheritedDescriptors: false,
      abortProcessGroupKilled: true,
      peakRssBytes,
      memoryGateBytes: MEMORY_GATE_BYTES,
    }),
  );
}

main().catch(async (error) => {
  await rm(runRoot, { recursive: true, force: true });
  console.error(
    error instanceof Error ? error.message : "qualification failed",
  );
  process.exitCode = 1;
});
