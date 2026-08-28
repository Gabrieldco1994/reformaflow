#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  REPAIR_TABLES,
  runRepair,
} from "./lib/repair-external-id-duplicates.mjs";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      values.apply = true;
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= argv.length) {
      throw new Error("invalid command line arguments");
    }
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }

  const result = {
    databaseUrl: values["database-url"],
    manifestPath: values.manifest,
    apply: values.apply === true,
  };
  if (!result.apply) return result;

  result.manifestSha256 = values["manifest-sha256"];
  result.expectedCounts = Object.fromEntries(
    REPAIR_TABLES.map((table) => [
      table,
      Object.fromEntries(
        ["groups", "rows", "nonkeepers"].map((metric) => {
          const raw = values[`expected-${table}-${metric}`];
          if (!/^(0|[1-9][0-9]*)$/.test(raw ?? "")) {
            throw new Error("all expected counts are required for --apply");
          }
          return [metric, Number(raw)];
        }),
      ),
    ]),
  );
  return result;
}

function safeSummary(result) {
  return JSON.stringify({
    mode: result.mode,
    counts: result.counts,
    updated: result.updated ?? 0,
    manifestSha256: result.manifestSha256,
  });
}

export async function main(argv) {
  const result = await runRepair(parseArguments(argv));
  console.log(safeSummary(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `repair failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
