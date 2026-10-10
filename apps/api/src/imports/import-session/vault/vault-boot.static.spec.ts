import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

// Same TypeScript AST traversal as vault-probe.lock.spec.ts C9; no text/regex import guesses.
function scan(source: string) {
  const file = ts.createSourceFile(
    "vault.ts",
    source,
    ts.ScriptTarget.ES2021,
    true,
  );
  const imports: string[] = [],
    dynamic: string[] = [],
    calls: string[] = [];
  const identifiers: string[] = [],
    members: string[] = [],
    topEffects: string[] = [];
  const processMembers: string[] = [],
    fsMembers: string[] = [],
    loggerImports: string[] = [];
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const nested =
      inFunction ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node);
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause,
        bindings = clause?.namedBindings;
      const typeOnly =
        clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) imports.push(node.moduleSpecifier.text);
      if (
        node.moduleSpecifier.text === "@nestjs/common" &&
        bindings &&
        ts.isNamedImports(bindings)
      )
        loggerImports.push(
          ...bindings.elements.map((e) => (e.propertyName ?? e.name).text),
        );
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      dynamic.push("re-export");
    if (ts.isImportEqualsDeclaration(node)) dynamic.push("import =");
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        dynamic.push("import()");
      if (ts.isIdentifier(node.expression)) {
        calls.push(node.expression.text);
        if (node.expression.text === "require") dynamic.push("require");
      }
      if (!nested) topEffects.push("call");
    }
    if (ts.isNewExpression(node) && !nested) topEffects.push("new");
    if (ts.isPropertyAccessExpression(node)) {
      members.push(node.name.text);
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "process"
      )
        processMembers.push(node.name.text);
      if (
        node.expression.getText(file) === "fs" ||
        node.expression.getText(file) === "fs.promises"
      )
        fsMembers.push(node.name.text);
    }
    if (ts.isElementAccessExpression(node)) dynamic.push("computed-member");
    if (
      ts.isIdentifier(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      identifiers.push(node.text);
      if (!nested && ["process", "performance"].includes(node.text))
        topEffects.push(node.text);
    }
    ts.forEachChild(node, (child) => visit(child, nested));
  };
  visit(file, false);
  return {
    imports: imports.sort(),
    dynamic,
    calls,
    identifiers,
    members,
    topEffects,
    processMembers,
    fsMembers,
    loggerImports,
  };
}
function source(name: string) {
  const path = join(__dirname, name);
  expect({ module: name, exists: existsSync(path) }).toEqual({
    module: name,
    exists: true,
  });
  return readFileSync(path, "utf8");
}
function unleasedImports(consumer: string, text: string): string[] {
  const modules = ["vault-boot", "vault-durability", "vault-probe"];
  const imports = ts
    .preProcessFile(text, true, true)
    .importedFiles.map((entry) => entry.fileName)
    .filter((name) => modules.some((module) => name.endsWith(module)));
  const file = ts.createSourceFile(
    "consumer.ts",
    text,
    ts.ScriptTarget.ES2021,
    true,
  );
  for (const node of file.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      continue;
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    if (
      !clause ||
      clause.name ||
      !bindings ||
      !ts.isNamedImports(bindings) ||
      bindings.elements.length === 0
    )
      continue;
    const module = node.moduleSpecifier.text;
    const storage =
      consumer === "imports/import-session/vault/vault-storage.ts";
    const purger = consumer === "imports/import-session/vault/vault-purger.ts";
    const gate = consumer === "imports/import-session/vault/vault-state.ts";
    const permitted = bindings.elements.every((entry) => {
      const name = (entry.propertyName ?? entry.name).text;
      const typeOnly = clause.isTypeOnly || entry.isTypeOnly;
      if (module === "./vault-boot")
        return (
          ((storage || purger || gate) &&
            typeOnly &&
            ["VaultBootHandle", "VaultRuntime"].includes(name)) ||
          (gate && !typeOnly && name === "startVaultBoot")
        );
      if (module !== "./vault-durability" || !storage) return false;
      return typeOnly
        ? [
            "VaultErrno",
            "FsFailure",
            "FsyncResult",
            "SpaceResult",
            "CleanupError",
          ].includes(name)
        : ["fsyncProbe", "availableBytes", "boundedCode"].includes(name);
    });
    if (permitted) imports.splice(imports.indexOf(module), 1);
  }
  return imports;
}
describe("inactive boot/durability AST boundary", () => {
  it("foundation leases are exact named imports, never boot values or arbitrary types/consumers", () => {
    const storage = "imports/import-session/vault/vault-storage.ts";
    const purger = "imports/import-session/vault/vault-purger.ts";
    expect(
      unleasedImports(
        storage,
        `
      import type { VaultBootHandle, VaultRuntime } from "./vault-boot";
      import { fsyncProbe, availableBytes, boundedCode, type VaultErrno } from "./vault-durability";
    `,
      ),
    ).toEqual([]);
    expect(
      unleasedImports(
        purger,
        `import { type VaultBootHandle } from "./vault-boot";`,
      ),
    ).toEqual([]);
    for (const text of [
      `import { VaultBootHandle } from "./vault-boot";`,
      `import type { VaultReason } from "./vault-boot";`,
      `import type * as Boot from "./vault-boot";`,
      `import type Boot from "./vault-boot";`,
      `export type { VaultBootHandle } from "./vault-boot";`,
      `type B = import("./vault-boot").VaultBootHandle;`,
      `require("./vault-boot");`,
      `import("./vault-boot");`,
      `import { startVaultBoot } from "./vault-boot";`,
    ])
      expect(unleasedImports(storage, text)).toEqual(["./vault-boot"]);
    expect(
      unleasedImports(
        "imports/other.ts",
        `import type { VaultBootHandle } from "./vault-boot";`,
      ),
    ).toEqual(["./vault-boot"]);
    expect(
      unleasedImports(
        purger,
        `import { boundedCode } from "./vault-durability";`,
      ),
    ).toEqual(["./vault-durability"]);
    expect(
      unleasedImports(
        storage,
        `import { collectRootFacts } from "./vault-probe";`,
      ),
    ).toEqual(["./vault-probe"]);
    expect(
      unleasedImports(
        storage,
        `import type { Arbitrary } from "./vault-durability";`,
      ),
    ).toEqual(["./vault-durability"]);
  });
  it("leases the canonical boot factory only to the exact private gate", () => {
    const gate = "imports/import-session/vault/vault-state.ts";
    expect(
      unleasedImports(
        gate,
        'import { startVaultBoot, type VaultBootHandle, type VaultRuntime } from "./vault-boot";',
      ),
    ).toEqual([]);
    for (const consumer of [
      "imports/import-session/import-session.module.ts",
      "imports/import-session/vault/import-upload.service.ts",
      "imports/import-session/vault/import-content.service.ts",
      "imports/import-session/vault/import-attachment.controller.ts",
      "imports/import-session/vault/vault-reaper.ts",
      "imports/import-session/vault/other/vault-state.ts",
    ])
      expect(
        unleasedImports(
          consumer,
          'import { startVaultBoot } from "./vault-boot";',
        ),
      ).toEqual(["./vault-boot"]);
    for (const text of [
      'import * as boot from "./vault-boot";',
      'export { startVaultBoot } from "./vault-boot";',
      'const boot = require("./vault-boot");',
      'import { VAULT_BOOT_DEADLINE_MS } from "./vault-boot";',
      'import { collectLockFacts } from "./vault-probe";',
      'import { fsyncProbe } from "./vault-durability";',
    ])
      expect(unleasedImports(gate, text)).toHaveLength(1);
  });
  it("scanner control: real imports/effects, not comments or strings; function clocks are not import-time reads", () => {
    const s = scan(`// console process.env setTimeout
      import { Logger } from "@nestjs/common";
      const text = "fs.closeSync(1)";
      function later() { performance.now(); process.geteuid(); }
      performance.now(); new Logger("x"); require("x"); fs.close(5);`);
    expect(s.imports).toEqual(["@nestjs/common"]);
    expect(s.loggerImports).toEqual(["Logger"]);
    expect(s.identifiers).not.toContain("console");
    expect(s.members).not.toContain("closeSync");
    expect(s.topEffects).toEqual([
      "call",
      "performance",
      "new",
      "call",
      "call",
    ]);
    expect(s.dynamic).toEqual(["require"]);
    expect(s.fsMembers).toEqual(["close"]);
  });
  it("boot has exact value imports, Nest Logger only, one unref timer and no import-time effects or product SPI", () => {
    const s = scan(source("vault-boot.ts"));
    expect(s.imports).toEqual([
      "./vault-durability",
      "./vault-lock",
      "./vault-probe",
      "./vault-root",
      "./vault.config",
      "@nestjs/common",
      "node:path",
    ]);
    expect(s.loggerImports).toEqual(["Logger"]);
    expect(s.dynamic).toEqual([]);
    expect(s.topEffects).toEqual([]);
    expect(s.calls.filter((x) => x === "setTimeout")).toHaveLength(1);
    expect(s.members).toContain("unref");
    expect(
      s.processMembers.every((x) => ["platform", "geteuid"].includes(x)),
    ).toBe(true);
    expect(
      s.identifiers.filter((x) =>
        [
          "Date",
          "console",
          "setInterval",
          "setImmediate",
          "queueMicrotask",
        ].includes(x),
      ),
    ).toEqual([]);
    expect(
      s.members.filter(
        (x) =>
          ["env", "message", "stack", "late"].includes(x) || x.endsWith("Sync"),
      ),
    ).toEqual([]);
    const file = ts.createSourceFile(
      "boot.ts",
      source("vault-boot.ts"),
      ts.ScriptTarget.ES2021,
      true,
    );
    const start = file.statements.find(
      (n): n is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(n) && n.name?.text === "startVaultBoot",
    );
    expect(start?.parameters.map((p) => p.name.getText(file))).toEqual([
      "env",
      "roots",
    ]);
  });
  it("durability only opens/syncs/closes its own handle and statfs; no writes, clock, logger, sync APIs or import effects", () => {
    const s = scan(source("vault-durability.ts"));
    expect(s.imports).toEqual(["node:fs"]);
    expect(s.dynamic).toEqual([]);
    expect(s.topEffects).toEqual([]);
    expect(
      s.fsMembers.filter(
        (x) => !["promises", "constants", "open", "statfs"].includes(x),
      ),
    ).toEqual([]);
    expect(
      s.identifiers.filter((x) =>
        [
          "Logger",
          "console",
          "process",
          "performance",
          "Date",
          "setTimeout",
          "setInterval",
          "setImmediate",
          "Number",
          "parseInt",
          "parseFloat",
        ].includes(x),
      ),
    ).toEqual([]);
    expect(
      s.members.filter(
        (x) =>
          x.endsWith("Sync") ||
          x.startsWith("write") ||
          [
            "O_CREAT",
            "mkdir",
            "rm",
            "unlink",
            "rename",
            "appendFile",
            "createWriteStream",
            "chmod",
            "chown",
            "symlink",
            "link",
            "truncate",
            "copyFile",
          ].includes(x),
      ),
    ).toEqual([]);
    for (const required of [
      "O_RDONLY",
      "O_DIRECTORY",
      "O_NOFOLLOW",
      "open",
      "sync",
      "close",
      "statfs",
    ])
      expect(s.members).toContain(required);
  });
  it("only the private gate may consume the boot factory; collectors keep their boot-only boundary", () => {
    const root = join(__dirname, "../../..");
    const bootValueCallers: string[] = [];
    const callers: Record<string, string[]> = {
      "vault-boot": [],
      "vault-durability": [],
      "vault-probe": [],
    };
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!["node_modules", "dist", "test-utils"].includes(entry.name))
            walk(path);
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".spec.ts") &&
          !entry.name.endsWith(".test.ts")
        ) {
          const text = readFileSync(path, "utf8");
          const file = ts.createSourceFile(
            path,
            text,
            ts.ScriptTarget.Latest,
            true,
          );
          for (const node of file.statements) {
            if (
              ts.isImportDeclaration(node) &&
              ts.isStringLiteral(node.moduleSpecifier) &&
              node.moduleSpecifier.text.endsWith("vault-boot") &&
              !node.importClause?.isTypeOnly &&
              node.importClause?.namedBindings &&
              ts.isNamedImports(node.importClause.namedBindings) &&
              node.importClause.namedBindings.elements.some(
                (entry) => !entry.isTypeOnly,
              )
            )
              bootValueCallers.push(relative(root, path));
          }
          for (const imported of unleasedImports(relative(root, path), text))
            for (const name of Object.keys(callers))
              if (imported.endsWith(name))
                callers[name].push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(bootValueCallers).toEqual(
      existsSync(join(__dirname, "vault-state.ts"))
        ? ["imports/import-session/vault/vault-state.ts"]
        : [],
    );
    expect(callers).toEqual({
      "vault-boot": [],
      "vault-durability": ["imports/import-session/vault/vault-boot.ts"],
      "vault-probe": ["imports/import-session/vault/vault-boot.ts"],
    });
  });
});
