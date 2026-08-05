import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditRepository,
  parseDispatchMatrix,
  parseFrontmatter,
} from "../validate-agent-contracts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");
const validFixture = join(here, "__fixtures__/agent-contracts/valid");
const temporaryRepositories = [];

function fixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "reformaflow-agent-contracts-"));
  temporaryRepositories.push(root);
  cpSync(validFixture, root, { recursive: true });
  return root;
}

function agentPath(root, name) {
  return join(root, ".claude/agents", `${name}.md`);
}

function edit(path, mutate) {
  writeFileSync(path, mutate(readFileSync(path, "utf8")));
}

function diagnostics(result) {
  return JSON.stringify(
    result.errors ?? result.issues ?? result.diagnostics ?? result,
    null,
    2,
  );
}

async function expectAuditFailure(root, expectedDiagnostic) {
  const result = await auditRepository(root);
  assert.equal(result.ok, false, "the invalid repository must fail its audit");
  assert.match(diagnostics(result), expectedDiagnostic);
}

afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agent contract validation", () => {
  test("accepts a complete minimal repository fixture", async () => {
    const result = await auditRepository(fixtureRepository());

    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors ?? result.issues ?? [], []);
  });

  test("rejects malformed frontmatter", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "web-experience-owner"), (source) =>
      source.replace(
        "name: web-experience-owner",
        "name: [web-experience-owner",
      ),
    );

    await expectAuditFailure(root, /FRONTMATTER_INVALID|frontmatter|ya?ml/i);
  });

  test("accepts a valid single-quoted YAML frontmatter scalar", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "web-experience-owner"), (source) =>
      source.replace(
        "name: web-experience-owner",
        "name: 'web-experience-owner'",
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors, []);
  });

  test("unescapes doubled quotes in a single-quoted YAML scalar", () => {
    const parsed = parseFrontmatter(
      ["---", "name: 'owner''s-contract'", "---", ""].join("\n"),
    );

    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.data.name, "owner's-contract");
  });

  test("rejects a frontmatter name different from its filename", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "web-experience-owner"), (source) =>
      source.replace(
        "name: web-experience-owner",
        "name: desktop-experience-owner",
      ),
    );

    await expectAuditFailure(
      root,
      /NAME_FILENAME_MISMATCH|name.{0,80}(file|arquivo)|filename/i,
    );
  });

  test("rejects an agent name outside kebab-case", async () => {
    const root = fixtureRepository();
    const oldPath = agentPath(root, "web-experience-owner");
    const newPath = join(root, ".claude/agents/WebExperienceOwner.md");
    edit(oldPath, (source) =>
      source.replace("name: web-experience-owner", "name: WebExperienceOwner"),
    );
    renameSync(oldPath, newPath);

    await expectAuditFailure(root, /NAME_NOT_KEBAB_CASE|kebab/i);
  });

  test("rejects aliases that collide after name normalization", async () => {
    const root = fixtureRepository();
    const alias = readFileSync(
      agentPath(root, "web-experience-owner"),
      "utf8",
    ).replaceAll("web-experience-owner", "webexperienceowner");
    writeFileSync(agentPath(root, "webexperienceowner"), alias);

    await expectAuditFailure(
      root,
      /NORMALIZED_NAME_COLLISION|collis|duplic|alias/i,
    );
  });

  test("rejects each required owner omitted from the Fleet PO allowlist", async (t) => {
    for (const owner of [
      "web-experience-owner",
      "mobile-experience-owner",
      "maria-ai-owner",
    ]) {
      await t.test(owner, async () => {
        const root = fixtureRepository();
        edit(agentPath(root, "fleet-po"), (source) =>
          source.replace(`  - ${owner}\n`, ""),
        );

        await expectAuditFailure(
          root,
          new RegExp(
            `FLEET_OWNER_MISSING|${owner}.{0,100}(missing|ausente)|missing.{0,100}${owner}`,
            "i",
          ),
        );
      });
    }
  });

  test("rejects a Fleet PO allowlist reference without an agent file", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "fleet-po"), (source) =>
      source.replace(
        "  - maria-ai-owner\n",
        "  - maria-ai-owner\n  - missing-experience-owner\n",
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.map(({ code }) => code),
      ["E_FLEET_AGENT_MISSING"],
    );
    assert.match(diagnostics(result), /missing-experience-owner/);
  });

  test("rejects a cited repository path that does not exist", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "web-experience-owner"), (source) =>
      source.replace("docs/README.md", "docs/missing-owner-map.md"),
    );

    await expectAuditFailure(
      root,
      /CITED_PATH_MISSING|missing-owner-map|path.{0,80}(missing|ausente)/i,
    );
  });

  test("ignores illustrative repository paths inside fenced examples", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "web-experience-owner"), (source) =>
      source.replace(
        "## Harness mínimo",
        [
          "Exemplo ilustrativo:",
          "",
          "```text",
          "`docs/fenced-example-does-not-exist.md`",
          "```",
          "",
          "## Harness mínimo",
        ].join("\n"),
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors, []);
  });

  test("accepts an existing Markdown link path with a fragment", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "web-experience-owner"), (source) =>
      source.replace("`docs/README.md`", "[README](docs/README.md#secao)"),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors, []);
  });

  test("does not let a query or fragment mask a missing Markdown path", async (t) => {
    for (const suffix of ["#secao", "?modo=qa"]) {
      await t.test(suffix, async () => {
        const root = fixtureRepository();
        edit(agentPath(root, "web-experience-owner"), (source) =>
          source.replace(
            "`docs/README.md`",
            `[README](docs/missing-owner-map.md${suffix})`,
          ),
        );

        const result = await auditRepository(root);
        assert.equal(result.ok, false);
        assert.deepEqual(
          result.errors.map(({ code }) => code),
          ["E_CITED_PATH_MISSING"],
        );
        assert.match(diagnostics(result), /docs\/missing-owner-map\.md/);
      });
    }
  });

  test("rejects dispatching the domain-user-lens template", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "fleet-po"), (source) =>
      source.replace(
        "  - maria-ai-owner\n",
        "  - maria-ai-owner\n  - domain-user-lens\n",
      ),
    );

    await expectAuditFailure(
      root,
      /TEMPLATE_DISPATCHABLE|domain-user-lens.{0,100}template|template/i,
    );
  });

  test("rejects every required owner section when independently absent", async (t) => {
    const requiredSections = [
      "Decide",
      "Não decide",
      "Delega para",
      "Consulta",
      "Escala",
      "Descoberta obrigatória",
      "Harness mínimo",
    ];

    for (const section of requiredSections) {
      await t.test(section, async () => {
        const root = fixtureRepository();
        edit(agentPath(root, "web-experience-owner"), (source) =>
          source.replace(
            new RegExp(`\\n## ${section}\\n[\\s\\S]*?(?=\\n## |$)`),
            "",
          ),
        );

        await expectAuditFailure(
          root,
          new RegExp(
            `REQUIRED_SECTION_MISSING|${section}|required.{0,80}section`,
            "i",
          ),
        );
      });
    }
  });

  test("rejects a harness command whose target does not exist", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "mobile-experience-owner"), (source) =>
      source.replace(
        "node --test scripts/lib/harness-smoke.test.mjs",
        "npm run test:mobile-contract-missing",
      ),
    );

    await expectAuditFailure(
      root,
      /HARNESS_COMMAND_MISSING|mobile-contract-missing|harness.{0,100}(missing|inexistente)/i,
    );
  });

  test("rejects a missing vitest target after changing directories", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "maria-ai-owner"), (source) =>
      source.replace(
        "node --test scripts/lib/harness-smoke.test.mjs",
        "cd packages/domain && npx vitest run __tests__/missing-expense-voice-parser.test.ts",
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.map(({ code }) => code),
      ["E_HARNESS_COMMAND_MISSING"],
    );
    assert.match(diagnostics(result), /missing-expense-voice-parser/);
  });

  test("rejects a missing target passed directly to node --test", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "mobile-experience-owner"), (source) =>
      source.replace(
        "scripts/lib/harness-smoke.test.mjs",
        "scripts/lib/missing-node-test-target.test.mjs",
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.map(({ code }) => code),
      ["E_HARNESS_COMMAND_MISSING"],
    );
    assert.match(diagnostics(result), /missing-node-test-target/);
  });

  test("rejects a missing second target passed to node --test", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "mobile-experience-owner"), (source) =>
      source.replace(
        "scripts/lib/harness-smoke.test.mjs",
        [
          "scripts/lib/harness-smoke.test.mjs",
          "scripts/lib/missing-second.test.mjs",
        ].join(" "),
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.map(({ code }) => code),
      ["E_HARNESS_COMMAND_MISSING"],
    );
    assert.match(diagnostics(result), /missing-second/);
  });

  test("accepts a node --test timeout flag with a separate value", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "mobile-experience-owner"), (source) =>
      source.replace(
        "node --test scripts/lib/harness-smoke.test.mjs",
        "node --test --test-timeout 1000 scripts/lib/harness-smoke.test.mjs",
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors, []);
  });

  test("accepts a quoted node --test skip pattern without treating its words as targets", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "mobile-experience-owner"), (source) =>
      source.replace(
        "node --test scripts/lib/harness-smoke.test.mjs",
        'node --test --test-skip-pattern "mobile smoke" scripts/lib/harness-smoke.test.mjs',
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors, []);
  });

  test("accepts a path-shaped node --test skip pattern as an option value", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "mobile-experience-owner"), (source) =>
      source.replace(
        "node --test scripts/lib/harness-smoke.test.mjs",
        'node --test --test-skip-pattern "scripts/missing-pattern.test.mjs" scripts/lib/harness-smoke.test.mjs',
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors, []);
  });

  test("detects a missing node --test target when a global flag precedes --test", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "mobile-experience-owner"), (source) =>
      source.replace(
        "node --test scripts/lib/harness-smoke.test.mjs",
        "node --no-warnings --test scripts/lib/missing-after-global-flag.test.mjs",
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.errors.map(({ code }) => code),
      ["E_HARNESS_COMMAND_MISSING"],
    );
    assert.match(diagnostics(result), /missing-after-global-flag/);
  });

  test("accepts two node --test commands chained with && when both targets exist", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "mobile-experience-owner"), (source) =>
      source.replace(
        "Run `node --test scripts/lib/harness-smoke.test.mjs`.",
        "Run `node --test scripts/lib/harness-smoke.test.mjs && node --test scripts/lib/harness-smoke.test.mjs`.",
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors, []);
  });

  test("accepts two npx vitest run commands chained with && after changing directories", async () => {
    const root = fixtureRepository();
    edit(agentPath(root, "maria-ai-owner"), (source) =>
      source.replace(
        "Run `node --test scripts/lib/harness-smoke.test.mjs`.",
        "Run `cd scripts/lib && npx vitest run harness-smoke.test.mjs && npx vitest run harness-smoke.test.mjs`.",
      ),
    );

    const result = await auditRepository(root);
    assert.equal(result.ok, true, diagnostics(result));
    assert.deepEqual(result.errors, []);
  });

  test("rejects every required matrix axis when empty for every scenario", async () => {
    const scenarios = {
      "web-desktop": {
        "Canais afetados": "navegador desktop",
        "Consultas/lens por fontes vivas": "lens Web em `docs/README.md`",
        "Impacto/guardiões plataforma": "sem impacto na plataforma Web",
        Implementadores: "`frontend-expert` para Web",
        "Avaliadores/gates": "`qa-engineer` e gate Web",
        Conclusão: "harness Web aprovado",
      },
      "mobile-pwa": {
        "Canais afetados": "viewport mobile e PWA",
        "Consultas/lens por fontes vivas": "lens Mobile em `docs/README.md`",
        "Impacto/guardiões plataforma": "guardião PWA quando aplicável",
        Implementadores: "`frontend-expert` para Mobile",
        "Avaliadores/gates": "`journey-qa` e gate Mobile",
        Conclusão: "harness Mobile aprovado",
      },
      "maria-cross-channel": {
        "Canais afetados": "Maria em Web e Mobile",
        "Consultas/lens por fontes vivas": "fontes Maria em `docs/README.md`",
        "Impacto/guardiões plataforma": "guardião da plataforma de IA",
        Implementadores: "`backend-expert` para Maria",
        "Avaliadores/gates": "`ai-quality-engineer` e gate Maria",
        Conclusão: "harness Maria aprovado",
      },
      "multi-channel": {
        "Canais afetados": "Web Mobile e Maria",
        "Consultas/lens por fontes vivas":
          "lenses dos canais em `docs/README.md`",
        "Impacto/guardiões plataforma": "guardiões Web Mobile e IA",
        Implementadores: "builders Web Mobile e Maria",
        "Avaliadores/gates": "QA runtime e gates combinados",
        Conclusão: "QA runtime combinado aprovado",
      },
      "platform-only": {
        "Canais afetados": "plataforma sem canal de experiência",
        "Consultas/lens por fontes vivas":
          "fonte de plataforma em `docs/README.md`",
        "Impacto/guardiões plataforma": "`platform-sre` como guardião",
        Implementadores: "implementador de plataforma aplicável",
        "Avaliadores/gates": "testes e gate da plataforma",
        Conclusão: "testes da plataforma aprovados",
      },
    };
    const unexpectedPasses = [];

    for (const [scenario, axes] of Object.entries(scenarios)) {
      for (const [axis, value] of Object.entries(axes)) {
        const root = fixtureRepository();
        edit(join(root, "docs/landscape-agentes-skills-saas.md"), (source) => {
          assert.equal(
            source.includes(value),
            true,
            `fixture cell missing for ${scenario} / ${axis}`,
          );
          return source.replace(value, "");
        });

        const result = await auditRepository(root);
        if (result.ok) unexpectedPasses.push(`${scenario} / ${axis}`);
      }
    }

    assert.deepEqual(unexpectedPasses, []);
  });
});

test("canonical dispatch matrix has all five deterministic primary owners", () => {
  const markdown = readFileSync(
    join(repositoryRoot, "docs/landscape-agentes-skills-saas.md"),
    "utf8",
  );
  const parsed = parseDispatchMatrix(markdown);
  const rows =
    parsed instanceof Map
      ? [...parsed].map(([id, value]) => ({
          id,
          ...(typeof value === "string" ? { primaryOwner: value } : value),
        }))
      : Array.isArray(parsed)
        ? parsed
        : Object.entries(parsed).map(([id, value]) => ({
            id,
            ...(typeof value === "string" ? { primaryOwner: value } : value),
          }));
  const primaryById = Object.fromEntries(
    rows.map((row) => [
      row.id ?? row.scenarioId,
      row.primaryOwner ?? row.primary ?? row.owner,
    ]),
  );

  assert.deepEqual(primaryById, {
    "web-desktop": "web-experience-owner",
    "mobile-pwa": "mobile-experience-owner",
    "maria-cross-channel": "maria-ai-owner",
    "multi-channel": "maria-ai-owner",
    "platform-only": "fleet-po",
  });
});

test("the assembled candidate repository passes the complete audit", async () => {
  const result = await auditRepository(repositoryRoot);

  assert.equal(result.ok, true, diagnostics(result));
  assert.deepEqual(result.errors ?? result.issues ?? [], []);
});
