#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = ".claude/agents";
const LANDSCAPE = "docs/landscape-agentes-skills-saas.md";
const OWNERS =
  "web-experience-owner mobile-experience-owner maria-ai-owner".split(" ");
const SECTIONS =
  "Decide|Não decide|Delega para|Consulta|Escala|Descoberta obrigatória|Harness mínimo".split(
    "|",
  );
const PRIMARIES = new Map([
  ["web-desktop", "web-experience-owner"],
  ["mobile-pwa", "mobile-experience-owner"],
  ["maria-cross-channel", "maria-ai-owner"],
  ["multi-channel", "maria-ai-owner"],
  ["platform-only", "fleet-po"],
]);
const FRONTMATTER_KEYS = new Set(
  "name description tools agents role template".split(" "),
);
const ROOT_FILE = /^(?:(?:AGENTS|CLAUDE|README)\.md|package\.json)$/;
const PATH_PREFIX = /^(?:\.claude|\.github|apps|docs|packages|scripts)\//;
const MATRIX_AXES = [
  ["channels", (header) => header.includes("canais afetados")],
  [
    "livingLens",
    (header) => header.startsWith("consulta") && header.includes("lens"),
  ],
  [
    "platformGuardians",
    (header) => header.includes("plataforma") && header.includes("guardioes"),
  ],
  ["implementers", (header) => header.startsWith("implementador")],
  [
    "evaluators",
    (header) => header.includes("avaliadores") && header.includes("gates"),
  ],
  ["completion", (header) => header.includes("conclusao")],
];
const issue = (code, file, message) => ({ code, file, message });

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function normalize(value) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function normalizeAgent(value) {
  return value
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/\.agent$/i, "")
    .replace(/[\s-]/g, "");
}

function invalidFrontmatter(file, line, message) {
  return issue("E_FRONTMATTER_INVALID", file, `line ${line}: ${message}`);
}

function scalar(raw) {
  if (!raw) return null;
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) return null;
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[\[{\]&*!]|^-\s/.test(raw)) return null;
  if (!raw.startsWith('"')) return raw;
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function parseFrontmatter(source, file = "<input>") {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const failure = (line, message, body = "") => ({
    data: null,
    body,
    diagnostics: [invalidFrontmatter(file, line, message)],
  });
  if (lines[0] !== "---") {
    return failure(1, "opening delimiter is missing", source);
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    return failure(1, "closing delimiter is missing");
  }

  const body = lines.slice(end + 1).join("\n");
  const data = {};
  const seen = new Set();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([a-z][a-z-]*):(?:\s*(.*))?$/);
    if (!match || line.includes("\t")) {
      return failure(index + 1, "unsupported structure", body);
    }
    const [, key, raw = ""] = match;
    if (!FRONTMATTER_KEYS.has(key) || seen.has(key)) {
      return failure(index + 1, `unsupported or duplicate key "${key}"`, body);
    }
    seen.add(key);

    if (key === "agents") {
      if (raw) {
        return failure(index + 1, "agents must be a simple list", body);
      }
      const agents = [];
      while (index + 1 < end && lines[index + 1].startsWith("  ")) {
        index += 1;
        const item = lines[index].match(/^  - ([a-z0-9]+(?:-[a-z0-9]+)*)$/);
        if (!item) {
          return failure(index + 1, "invalid agents list item", body);
        }
        agents.push(item[1]);
      }
      data.agents = agents;
      continue;
    }

    if (key === "template") {
      if (raw !== "true" && raw !== "false") {
        return failure(index + 1, "template must be boolean", body);
      }
      data.template = raw === "true";
      continue;
    }

    if (/^[>|][+-]?$/.test(raw)) {
      let contentLines = 0;
      while (
        index + 1 < end &&
        (lines[index + 1] === "" || lines[index + 1].startsWith("  "))
      ) {
        index += 1;
        contentLines += lines[index] ? 1 : 0;
      }
      if (!contentLines) {
        return failure(index + 1, "empty text block", body);
      }
      continue;
    }

    const value = scalar(raw);
    if (value === null) return failure(index + 1, "invalid scalar", body);
    if (key === "name") data.name = value;
  }

  return { data, body, diagnostics: [] };
}

function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.replace(/[`*_]/g, "").trim());
}

export function parseDispatchMatrix(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length - 2; index += 1) {
    const header = cells(lines[index]);
    const separator = cells(lines[index + 1]);
    if (
      !header ||
      !separator ||
      !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      continue;
    }
    const normalized = header.map(normalize);
    const idColumn = normalized.indexOf("id");
    const ownerColumn = normalized.indexOf("owner primario");
    if (idColumn < 0 || ownerColumn < 0) continue;
    const axisColumns = MATRIX_AXES.map(([key, matches]) => [
      key,
      normalized.findIndex(matches),
    ]);

    const rows = [];
    for (index += 2; index < lines.length; index += 1) {
      const row = cells(lines[index]);
      if (!row) break;
      const id = row[idColumn];
      if (PRIMARIES.has(id)) {
        rows.push({
          id,
          primary: row[ownerColumn],
          axes: Object.fromEntries(
            axisColumns.map(([key, column]) => [
              key,
              column < 0 ? "" : (row[column] ?? ""),
            ]),
          ),
        });
      }
    }
    return rows;
  }
  return [];
}

function markdownSections(body) {
  const headings = [...body.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)];
  return headings.map((heading, index) => ({
    title: normalize(heading[1].replace(/[`*_]/g, "")),
    content: body.slice(
      heading.index + heading[0].length,
      headings[index + 1]?.index ?? body.length,
    ),
  }));
}

function concretePaths(body) {
  const found = new Set();
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (
      fenced ||
      /\b(?:exemplo|example|ilustrativo|hipotetic[oa])\b/i.test(line)
    ) {
      continue;
    }
    for (const match of line.matchAll(/`([^`\n]+)`|\]\(([^)\s]+)\)/g)) {
      const candidate = (match[1] ?? match[2])
        .split(/[?#]/, 1)[0]
        .replace(/[:#]\d+(?:-\d+)?$/, "");
      if (
        !candidate.includes(" ") &&
        !/[*?{}<>$]|^(?:https?:|\/)/.test(candidate) &&
        (ROOT_FILE.test(candidate) || PATH_PREFIX.test(candidate))
      ) {
        found.add(candidate);
      }
    }
  }
  return [...found].sort();
}

function commandError(file, command, target) {
  return issue(
    "E_HARNESS_COMMAND_MISSING",
    file,
    `harness command "${command}" references missing target "${target}"`,
  );
}

function commandTokens(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

const BOOLEAN_NODE_TEST_OPTIONS = new Set([
  "--test-force-exit",
  "--test-only",
  "--test-update-snapshots",
]);

function concreteTargets(tokens) {
  const targets = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--test-")) {
      if (!token.includes("=") && !BOOLEAN_NODE_TEST_OPTIONS.has(token)) {
        index += 1;
      }
      continue;
    }
    if (!token.startsWith("-") && !/[*?{}<>$]/.test(token)) {
      targets.push(token);
    }
  }
  return targets;
}

// Splits a harness command on top-level `&&` chains, i.e. `&&` that is not
// nested inside a single- or double-quoted option value. Each returned
// segment is independently re-validated against the same shapes supported
// below (npm run / node --test / cd ... && npx ...); a quoted `&&` (e.g. a
// `--test-skip-pattern` value) must never be treated as a chain boundary.
function splitTopLevelSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current.trim());
  return segments;
}

const CD_ONLY = /^cd ([^\s]+)$/;
const NPX_INVOCATION =
  /^(?:(?:TZ=UTC)\s+)?npx (playwright test|jest|vitest run)\s+(.+)$/;

function validateHarness(root, file, content, packageJson) {
  const errors = [];
  for (const match of content.matchAll(/`([^`\n]+)`/g)) {
    const command = match[1].trim();
    const segments = splitTopLevelSegments(command);
    // `cwd` carries forward across segments of the same chained command, so
    // any number of `npx ...` segments after a `cd DIR` are validated against
    // that directory, not just the one immediately following the `cd`. It is
    // `null` until a `cd` segment resolves successfully (no bare `npx ...`
    // without a preceding `cd` is a supported shape) and stays `null` after a
    // `cd` to a missing directory, so we don't also flag downstream targets
    // against a stale or wrong directory once the `cd` itself already failed.
    let cwd = null;

    for (const segment of segments) {
      const cd = segment.match(CD_ONLY);
      if (cd) {
        const nextCwd = path.resolve(root, cd[1]);
        if (!fs.existsSync(nextCwd)) {
          errors.push(commandError(file, command, cd[1]));
          cwd = null;
        } else {
          cwd = nextCwd;
        }
        continue;
      }

      const npx = cwd ? segment.match(NPX_INVOCATION) : null;
      if (npx) {
        const targets = npx[2]
          .split(/\s+/)
          .filter(
            (token) => !token.startsWith("-") && !/[*?{}<>$]/.test(token),
          );
        for (const target of targets) {
          if (!fs.existsSync(path.resolve(cwd, target))) {
            errors.push(commandError(file, command, target));
          }
        }
        continue;
      }

      const npm = segment.match(/^npm run ([a-z0-9:_-]+)$/);
      if (npm) {
        if (!Object.hasOwn(packageJson.scripts ?? {}, npm[1])) {
          errors.push(commandError(file, command, npm[1]));
        }
        continue;
      }

      const tokens = commandTokens(segment);
      const testOption = tokens.indexOf("--test");
      if (tokens[0] === "node" && testOption >= 0) {
        const targets = concreteTargets(tokens.slice(testOption + 1));
        if (!targets.length) {
          errors.push(commandError(file, command, "<target>"));
        }
        for (const target of targets) {
          if (!fs.existsSync(path.resolve(root, target))) {
            errors.push(commandError(file, command, target));
          }
        }
        continue;
      }
    }
  }
  return errors;
}

function sortIssues(errors) {
  return errors.sort(
    (left, right) =>
      compare(left.file, right.file) ||
      compare(left.code, right.code) ||
      compare(left.message, right.message),
  );
}

export function auditContracts(root = process.cwd()) {
  const errors = [];
  const report = (code, file, message) =>
    errors.push(issue(code, file, message));
  const agentRoot = path.resolve(root, AGENT_DIR);
  if (!fs.existsSync(agentRoot)) {
    return [
      issue(
        "E_AGENTS_DIRECTORY_MISSING",
        AGENT_DIR,
        "agent directory is missing",
      ),
    ];
  }

  const agents = new Map();
  const collisions = new Map();
  const files = fs
    .readdirSync(agentRoot)
    .filter((file) => file.endsWith(".md"))
    .sort();
  for (const file of files) {
    const relative = `${AGENT_DIR}/${file}`;
    const parsed = parseFrontmatter(
      fs.readFileSync(path.join(agentRoot, file), "utf8"),
      relative,
    );
    errors.push(...parsed.diagnostics);
    if (!parsed.data) continue;

    const stem = file.slice(0, -3);
    const name = parsed.data.name;
    if (!name) {
      report("E_AGENT_NAME_MISSING", relative, "frontmatter name is missing");
      continue;
    }
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stem) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    ) {
      report(
        "E_NAME_NOT_KEBAB_CASE",
        relative,
        `"${stem}" / "${name}" must be kebab-case`,
      );
    }
    if (stem !== name) {
      report(
        "E_NAME_FILENAME_MISMATCH",
        relative,
        `name "${name}" differs from filename "${stem}"`,
      );
    }
    agents.set(name, { relative, body: parsed.body, data: parsed.data });
    for (const normalized of new Set([
      normalizeAgent(stem),
      normalizeAgent(name),
    ])) {
      const group = collisions.get(normalized) ?? new Set();
      group.add(relative);
      collisions.set(normalized, group);
    }
  }

  for (const [name, group] of collisions) {
    if (group.size > 1) {
      report(
        "E_NORMALIZED_NAME_COLLISION",
        [...group].sort()[0],
        `normalized name "${name}" collides across ${[...group].sort().join(", ")}`,
      );
    }
  }

  const fleet = agents.get("fleet-po");
  const allowlist = fleet?.data.agents ?? [];
  if (!fleet) {
    report(
      "E_FLEET_MISSING",
      `${AGENT_DIR}/fleet-po.md`,
      "Fleet PO is missing",
    );
  }
  for (const name of allowlist) {
    if (!agents.has(name)) {
      report(
        "E_FLEET_AGENT_MISSING",
        fleet.relative,
        `allowlisted agent "${name}" is missing`,
      );
    }
  }
  if (allowlist.includes("domain-user-lens")) {
    report(
      "E_TEMPLATE_DISPATCHABLE",
      fleet.relative,
      "domain-user-lens template cannot be dispatched",
    );
  }

  let packageJson = {};
  try {
    packageJson = JSON.parse(
      fs.readFileSync(path.resolve(root, "package.json"), "utf8"),
    );
  } catch {
    report(
      "E_PACKAGE_JSON_INVALID",
      "package.json",
      "package.json is missing or invalid",
    );
  }

  for (const name of OWNERS) {
    const owner = agents.get(name);
    if (!owner) {
      report(
        "E_OWNER_MISSING",
        `${AGENT_DIR}/${name}.md`,
        `required owner "${name}" is missing`,
      );
      continue;
    }
    if (!allowlist.includes(name)) {
      report(
        "E_FLEET_OWNER_MISSING",
        fleet?.relative ?? `${AGENT_DIR}/fleet-po.md`,
        `owner "${name}" is missing from Fleet PO`,
      );
    }
    const sections = markdownSections(owner.body);
    for (const title of SECTIONS) {
      if (!sections.some((section) => section.title === normalize(title))) {
        report(
          "E_REQUIRED_SECTION_MISSING",
          owner.relative,
          `required section "${title}" is missing`,
        );
      }
    }
    for (const citedPath of concretePaths(owner.body)) {
      if (!fs.existsSync(path.resolve(root, citedPath))) {
        report(
          "E_CITED_PATH_MISSING",
          owner.relative,
          `cited path "${citedPath}" is missing`,
        );
      }
    }
    const harness = sections.find(
      (section) => section.title === normalize("Harness mínimo"),
    );
    if (harness)
      errors.push(
        ...validateHarness(root, owner.relative, harness.content, packageJson),
      );
  }

  const landscape = path.resolve(root, LANDSCAPE);
  if (!fs.existsSync(landscape)) {
    report("E_MATRIX_MISSING", LANDSCAPE, "dispatch matrix is missing");
  } else {
    const rows = parseDispatchMatrix(fs.readFileSync(landscape, "utf8"));
    const byId = new Map();
    for (const row of rows) {
      if (byId.has(row.id)) {
        report(
          "E_MATRIX_ID_DUPLICATE",
          LANDSCAPE,
          `matrix ID "${row.id}" is duplicated`,
        );
      }
      byId.set(row.id, row);
    }
    for (const [id, primary] of PRIMARIES) {
      if (!byId.has(id)) {
        report(
          "E_MATRIX_ID_MISSING",
          LANDSCAPE,
          `matrix ID "${id}" is missing`,
        );
        continue;
      }
      const row = byId.get(id);
      if (row.primary !== primary) {
        report(
          "E_MATRIX_PRIMARY_INVALID",
          LANDSCAPE,
          `"${id}" must use primary "${primary}"`,
        );
      }
      for (const [axis] of MATRIX_AXES) {
        if (!row.axes[axis]) {
          report(
            "E_MATRIX_AXIS_EMPTY",
            LANDSCAPE,
            `"${id}" must define matrix axis "${axis}"`,
          );
        }
      }
    }
  }
  return sortIssues(errors);
}

export function auditRepository(root = process.cwd()) {
  const errors = auditContracts(root);
  return { ok: errors.length === 0, errors };
}

function runCli() {
  const result = auditRepository(process.argv[2] ?? process.cwd());
  if (result.ok) {
    console.log("PASS agent contracts");
    return;
  }
  for (const error of result.errors) {
    console.error(`${error.code} ${error.file}: ${error.message}`);
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
