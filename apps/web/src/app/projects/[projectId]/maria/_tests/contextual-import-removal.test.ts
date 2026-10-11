import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("final deterministic import composition", () => {
  it("has no residual contextual transport or public domain contract", () => {
    expect(
      existsSync(resolve(root, "packages/domain/src/import-conversation.ts")),
    ).toBe(false);
    expect(source("packages/domain/src/index.ts")).not.toMatch(
      /ImportChat(?:Turn|Outcome|Error|Ref)|ImportScopeReview/,
    );
    expect(source("apps/api/src/agent/dto/agent-chat.dto.ts")).not.toContain(
      "importTurn",
    );
  });

  it("has no contextual import tool, response reader or copy module", () => {
    const toolRoot = resolve(root, "apps/api/src/agent/tools");
    const toolSources = readdirSync(toolRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith(".ts"))
      .map((entry) => source(`apps/api/src/agent/tools/${String(entry)}`))
      .join("\n");
    expect(toolSources).not.toMatch(/ImportChat|importTurn|importOutcome/);
    expect(
      existsSync(
        resolve(
          root,
          "apps/web/src/app/projects/[projectId]/maria/_lib/import-conversation-read.ts",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(
          root,
          "apps/web/src/app/projects/[projectId]/maria/_lib/import-conversation-copy.ts",
        ),
      ),
    ).toBe(false);
  });
});
