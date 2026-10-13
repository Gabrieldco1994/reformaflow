import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { join } from "node:path";
import test from "node:test";
import {
  PDF_WORKER_PROBE_SOURCE,
  cgroupLevelStage,
  mapCgroupNamespacePath,
  observeDatabase,
  parsePdfWorkerEvents,
  parseNamespacePidMap,
  parseVmHwmBytes,
  serializeMetrics,
  verifyCgroupV2Proof,
} from "./maria-import-memory-benchmark.mjs";
import {
  buildBenchmarkFixtures,
  validateBoundaryStats,
} from "./maria-import-memory-fixtures.mjs";

const MEMORY_CAP_BYTES = 536_870_912;
const require = createRequire(import.meta.url);
const { ACTIVE_DB_PATH } = require("../../../scripts/test-db-env.cjs");
const EXPECTED_LABELS = [
  "pdf-max-c1",
  "pdf-max-c2",
  "upload-max-c1",
  "upload-max-c2",
  "upload-max-c5",
];

function cgroupEvidence(overrides = {}) {
  return {
    cgroupVersion: 2,
    cgroupNamespaceMode: "private",
    pid1CgroupPath: "/",
    dockerMemoryBytes: MEMORY_CAP_BYTES,
    dockerMemorySwapBytes: MEMORY_CAP_BYTES,
    hostHierarchyRootVerified: true,
    targetMountRootMapped: true,
    targetLeafMapped: true,
    mountIdentityVerified: true,
    pidIdentityVerified: true,
    ancestorWalkComplete: true,
    memoryMaxBytes: MEMORY_CAP_BYTES,
    memorySwapMaxBytes: 0,
    memorySwapCurrentBytes: 0,
    memoryCurrentBytes: 104_857_600,
    memoryPeakBytes: 157_286_400,
    hostCgroupLeafMemoryMaxBytes: MEMORY_CAP_BYTES,
    ancestorMemoryMaxBytes: [null, 1_073_741_824],
    ...overrides,
  };
}

function metricRow(label = "pdf-max-c1") {
  return {
    label,
    concurrency: 1,
    input_bytes: 10_485_760,
    page_count: 30,
    operator_count: 200_000,
    text_output_bytes: 10_485_760,
    registration_calls: 5,
    overlap_count: 1,
    analysis_calls: 1,
    distinct_tenant_count: 1,
    distinct_user_count: 1,
    financial_expense_count: 0,
    financial_cash_flow_count: 0,
    financial_receipt_count: 0,
    financial_allocation_count: 0,
    financial_settlement_count: 0,
    financial_liquidation_count: 0,
    cgroup_version: 2,
    private_cgroup_namespace: 1,
    host_hierarchy_root_verified: 1,
    target_mount_root_mapped: 1,
    target_leaf_mapped: 1,
    mount_identity_verified: 1,
    pid_identity_verified: 1,
    ancestor_walk_complete: 1,
    host_ancestor_count: 2,
    memory_limit_bytes: MEMORY_CAP_BYTES,
    swap_limit_bytes: 0,
    baseline_swap_current_bytes: 0,
    final_swap_current_bytes: 0,
    baseline_vm_hwm_bytes: 80_000_000,
    final_vm_hwm_bytes: 140_000_000,
    baseline_memory_current_bytes: 70_000_000,
    baseline_memory_peak_bytes: 90_000_000,
    final_memory_current_bytes: 100_000_000,
    final_memory_peak_bytes: 150_000_000,
    oom_event_delta: 0,
    oom_kill_delta: 0,
    status_code: 0,
  };
}

test("VmHWM is converted to bytes and missing or invalid samples fail closed", () => {
  assert.equal(parseVmHwmBytes("Name:\tnode\nVmHWM:\t123 kB\n"), 125_952);
  assert.throws(() => parseVmHwmBytes("Name:\tnode\n"));
  assert.throws(() => parseVmHwmBytes("VmHWM: unknown\n"));
  assert.throws(() => parseVmHwmBytes("VmHWM: 0 kB\n"));
  assert.throws(() => parseVmHwmBytes("VmHWM: -1 kB\n"));
});

test("namespace PID map accepts Linux tab-delimited values and rejects malformed status", () => {
  assert.deepEqual(
    parseNamespacePidMap("Name:\tnode\nNSpid:\t4321\t1\n"),
    [4321, 1],
  );
  assert.deepEqual(parseNamespacePidMap("NSpid: 4321 1\n"), [4321, 1]);
  assert.throws(() => parseNamespacePidMap("Name:\tnode\nUid:\t4321\n"));
  assert.throws(() => parseNamespacePidMap("NSpid:\t4321\tx\n"));
});

test("cgroup proof requires the exact private 512 MiB v2 leaf with zero swap", () => {
  assert.deepEqual(verifyCgroupV2Proof(cgroupEvidence()), {
    cgroupVersion: 2,
    privateCgroupNamespace: 1,
    hostHierarchyRootVerified: true,
    targetMountRootMapped: true,
    targetLeafMapped: true,
    mountIdentityVerified: true,
    pidIdentityVerified: true,
    ancestorWalkComplete: true,
    memoryLimitBytes: MEMORY_CAP_BYTES,
    swapLimitBytes: 0,
    swapCurrentBytes: 0,
    currentBytes: 104_857_600,
    peakBytes: 157_286_400,
    ancestorCount: 2,
  });

  for (const invalid of [
    { cgroupVersion: 1 },
    { cgroupNamespaceMode: "host" },
    { pid1CgroupPath: "/nested" },
    { dockerMemoryBytes: MEMORY_CAP_BYTES - 1 },
    { dockerMemorySwapBytes: MEMORY_CAP_BYTES * 2 },
    { memoryMaxBytes: MEMORY_CAP_BYTES - 1 },
    { memoryMaxBytes: MEMORY_CAP_BYTES + 1 },
    { memorySwapMaxBytes: 1 },
    { memorySwapCurrentBytes: 1 },
    { hostCgroupLeafMemoryMaxBytes: MEMORY_CAP_BYTES - 1 },
    { memoryCurrentBytes: 0 },
    { memoryPeakBytes: undefined },
    { ancestorMemoryMaxBytes: [null, MEMORY_CAP_BYTES - 1] },
    { hostHierarchyRootVerified: false },
    { targetMountRootMapped: false },
    { targetLeafMapped: false },
    { mountIdentityVerified: false },
    { pidIdentityVerified: false },
    { ancestorWalkComplete: false },
  ]) {
    assert.throws(() => verifyCgroupV2Proof(cgroupEvidence(invalid)));
  }
});

test("host cgroup diagnostics expose only bounded booleans and numeric depth", () => {
  const stage = cgroupLevelStage(2, {
    directory: true,
    directoryDeviceMatch: true,
    parentChildRelation: true,
    memoryMax: "missing",
    parentControllers: "readable",
    parentMemoryAvailable: false,
    parentSubtreeControl: "readable",
    memoryEnabledByParent: true,
    controllers: "readable",
    memoryAvailable: true,
    subtreeControl: "readable",
    memoryEnabledForChildren: false,
    typeStatus: "readable",
    type: "domain",
  });
  assert.equal(
    stage,
    "host-cgroup-level-2-dir-1-device-1-parent-relation-1-max-missing-parent-controllers-readable-parent-available-0-parent-sc-readable-parent-mem-1-controllers-readable-available-1-subtree-readable-child-mem-0-type-status-readable-type-domain",
  );
  assert.doesNotMatch(stage, /[/\\]|secret|path|token/);
  assert.throws(() => cgroupLevelStage(256, {}));
});

test("private cgroup mount root maps the container-relative path to its host path", () => {
  assert.equal(
    mapCgroupNamespacePath("/system.slice/docker/example.scope", "/"),
    "/system.slice/docker/example.scope",
  );
  assert.equal(
    mapCgroupNamespacePath("/system.slice/docker/example.scope", "/child"),
    "/system.slice/docker/example.scope/child",
  );
  assert.throws(() =>
    mapCgroupNamespacePath("/system.slice/docker/example.scope", "/../other"),
  );
  assert.throws(() => mapCgroupNamespacePath("relative/root", "/"));
  assert.throws(() =>
    mapCgroupNamespacePath("/system.slice", "/bad\u0000path"),
  );
});

test("PDF worker probe counts overlapping started workers without identifiers", () => {
  const directory = mkdtempSync(join(tmpdir(), "rf-pdf-worker-probe-"));
  try {
    const preload = join(directory, "probe.cjs");
    const events = join(directory, "events.ndjson");
    const worker = join(directory, "pdf-document.worker.mjs");
    writeFileSync(preload, PDF_WORKER_PROBE_SOURCE, { mode: 0o600 });
    writeFileSync(events, "", { mode: 0o600 });
    writeFileSync(
      worker,
      'import { setTimeout as delay } from "node:timers/promises"; await delay(150);\n',
      { mode: 0o600 },
    );
    const source = `
      const { Worker } = require("node:worker_threads");
      const workers = [1, 2].map(() => new Worker(process.env.WORKER_SCRIPT));
      Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error()));
      }))).catch(() => { process.exitCode = 1; });
    `;
    const result = spawnSync(
      process.execPath,
      ["--require", preload, "-e", source],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          WORKER_SCRIPT: worker,
          RF_MEMORY_BENCHMARK_WORKER_EVENTS: events,
        },
      },
    );
    assert.equal(result.status, 0, "test-only worker probe child failed");
    assert.deepEqual(parsePdfWorkerEvents(readFileSync(events, "utf8")), {
      activeCount: 0,
      maxConcurrentWorkers: 2,
      startCount: 2,
      exitCount: 2,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixture validator accepts only verified exact parser boundaries", () => {
  const expected = {
    nearFileBytes: 10_485_759,
    maxFileBytes: 10_485_760,
    pages: 30,
    operatorsOnBoundaryPage: 200_000,
    textPagesWithText: 30,
    outputUtf8Bytes: 10_485_760,
    purchaseCount: 1,
  };
  assert.deepEqual(validateBoundaryStats(expected), expected);

  for (const invalid of [
    { nearFileBytes: 10_485_758 },
    { maxFileBytes: 10_485_759 },
    { pages: 29 },
    { operatorsOnBoundaryPage: 199_999 },
    { outputUtf8Bytes: 10_485_759 },
    { purchaseCount: 0 },
  ]) {
    assert.throws(() => validateBoundaryStats({ ...expected, ...invalid }));
  }
});

test("synthetic corpus hits the accepted PDF boundaries in the production parsers", async () => {
  const fixtures = await buildBenchmarkFixtures();
  const actual = validateBoundaryStats({
    nearFileBytes: fixtures.nearSize.bytes.length,
    maxFileBytes: fixtures.maxAccepted.bytes.length,
    pages: fixtures.maxAccepted.stats.pages,
    operatorsOnBoundaryPage: fixtures.maxAccepted.stats.operatorsOnBoundaryPage,
    textPagesWithText: fixtures.maxAccepted.stats.textPagesWithText,
    outputUtf8Bytes: fixtures.maxAccepted.stats.outputUtf8Bytes,
    purchaseCount: fixtures.maxAccepted.stats.purchaseCount,
  });
  assert.deepEqual(actual, {
    nearFileBytes: 10_485_759,
    maxFileBytes: 10_485_760,
    pages: 30,
    operatorsOnBoundaryPage: 200_000,
    textPagesWithText: 30,
    outputUtf8Bytes: 10_485_760,
    purchaseCount: 1,
  });
  assert.equal(fixtures.pagesOver.stats.pages, 31);
  assert.equal(fixtures.pagesOver.stats.textPagesWithText, 31);
  assert.equal(fixtures.operatorsOver.stats.operatorsOnBoundaryPage, 200_001);
  assert.equal(fixtures.textOver.stats.outputUtf8Bytes, 10_485_761);
});

test("metrics output contains only allowlisted labels and numeric evidence", () => {
  const sentinel = "SYNTHETIC_PRIVATE_SENTINEL";
  const row = {
    ...metricRow(),
    documentText: sentinel,
    filename: sentinel,
    sessionId: sentinel,
    path: sentinel,
    token: sentinel,
    rawError: sentinel,
  };
  const output = serializeMetrics([row]);
  const json = JSON.stringify(output);

  assert.doesNotMatch(json, new RegExp(sentinel));
  assert.deepEqual(output.rows, [metricRow()]);
  assert.throws(() =>
    serializeMetrics([{ ...metricRow(), final_vm_hwm_bytes: 0 }]),
  );
  assert.throws(() =>
    serializeMetrics([{ ...metricRow(), label: "../private" }]),
  );
});

test("database observer is read-only and returns only synthetic aggregates", () => {
  assert.match(basename(ACTIVE_DB_PATH), /^test(?:-worker-\d+)?\.db$/);
  const before = createHash("sha256")
    .update(readFileSync(ACTIVE_DB_PATH))
    .digest("hex");
  const observation = observeDatabase(ACTIVE_DB_PATH, [randomUUID()]);
  const after = createHash("sha256")
    .update(readFileSync(ACTIVE_DB_PATH))
    .digest("hex");
  assert.equal(before, after);
  assert.deepEqual(observation, {
    uploadCount: 0,
    uploadTenantCount: 0,
    uploadUserCount: 0,
    analyzingCount: 0,
    analyzingTenantCount: 0,
    analyzingUserCount: 0,
    financialCounts: [0, 0, 0, 0, 0, 0],
    observationCount: 0,
  });
});

test(
  "live benchmark records all bounded upload and PDF scenarios",
  {
    skip: process.env.RF_MEMORY_BENCHMARK_LIVE !== "1",
    timeout: 40 * 60_000,
  },
  async () => {
    const { runBenchmark } =
      await import("./maria-import-memory-benchmark.mjs");
    const result = await runBenchmark();
    assert.deepEqual(
      result.rows.map(({ label }) => label),
      EXPECTED_LABELS,
    );
    assert.equal(result.registration_calls, 5);

    for (const row of result.rows) {
      assert.equal(row.memory_limit_bytes, MEMORY_CAP_BYTES, row.label);
      assert.equal(row.cgroup_version, 2, row.label);
      assert.equal(row.private_cgroup_namespace, 1, row.label);
      assert.equal(row.host_hierarchy_root_verified, 1, row.label);
      assert.equal(row.target_mount_root_mapped, 1, row.label);
      assert.equal(row.target_leaf_mapped, 1, row.label);
      assert.equal(row.mount_identity_verified, 1, row.label);
      assert.equal(row.pid_identity_verified, 1, row.label);
      assert.equal(row.ancestor_walk_complete, 1, row.label);
      assert.equal(row.swap_limit_bytes, 0, row.label);
      assert.equal(row.baseline_swap_current_bytes, 0, row.label);
      assert.equal(row.final_swap_current_bytes, 0, row.label);
      assert.ok(row.baseline_vm_hwm_bytes > 0, row.label);
      assert.ok(row.final_vm_hwm_bytes > 0, row.label);
      assert.ok(row.baseline_memory_peak_bytes > 0, row.label);
      assert.ok(
        row.final_memory_peak_bytes >= row.baseline_memory_peak_bytes,
        row.label,
      );
      assert.equal(row.oom_event_delta, 0, row.label);
      assert.equal(row.oom_kill_delta, 0, row.label);
      assert.equal(row.status_code, 0, row.label);
      for (const field of [
        "financial_expense_count",
        "financial_cash_flow_count",
        "financial_receipt_count",
        "financial_allocation_count",
        "financial_settlement_count",
        "financial_liquidation_count",
      ]) {
        assert.equal(row[field], 0, `${row.label}: ${field}`);
      }
    }

    const uploadRows = result.rows.filter(({ label }) =>
      label.startsWith("upload-"),
    );
    assert.deepEqual(
      uploadRows.map(({ concurrency, overlap_count }) => [
        concurrency,
        overlap_count,
      ]),
      [
        [1, 1],
        [2, 2],
        [5, 5],
      ],
    );
    assert.deepEqual(
      uploadRows.map(
        ({ concurrency, distinct_tenant_count, distinct_user_count }) => [
          concurrency,
          distinct_tenant_count,
          distinct_user_count,
        ],
      ),
      [
        [1, 1, 1],
        [2, 2, 2],
        [5, 5, 5],
      ],
    );
    assert.deepEqual(
      uploadRows.map(({ analysis_calls }) => analysis_calls),
      [0, 0, 0],
    );
    const pdfRows = result.rows.filter(({ label }) => label.startsWith("pdf-"));
    assert.deepEqual(
      pdfRows.map(({ analysis_calls, concurrency }) => [
        analysis_calls,
        concurrency,
      ]),
      [
        [1, 1],
        [2, 2],
      ],
    );
    assert.deepEqual(
      pdfRows.map(
        ({ concurrency, page_count, operator_count, text_output_bytes }) => [
          concurrency,
          page_count,
          operator_count,
          text_output_bytes,
        ],
      ),
      [
        [1, 30, 200_000, 10_485_760],
        [2, 30, 200_000, 10_485_760],
      ],
    );

    const artifact = JSON.parse(
      readFileSync(process.env.RF_MEMORY_BENCHMARK_OUTPUT, "utf8"),
    );
    assert.deepEqual(artifact, result);
    assert.doesNotMatch(JSON.stringify(artifact), /SYNTHETIC_PRIVATE_SENTINEL/);
  },
);
