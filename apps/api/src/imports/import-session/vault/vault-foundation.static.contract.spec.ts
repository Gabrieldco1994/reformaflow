import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import * as ts from "typescript";
import {
  loadPurger,
  loadRegistry,
  loadStorage,
} from "../../../test-utils/vault-foundation-harness";

type Violation = { rule: string; file: string; at: number };
const foundation = [
  "vault-fd-registry.ts",
  "vault-storage.ts",
  "vault-purger.ts",
];
const consumers = [
  "import-upload.service.ts",
  "import-content.service.ts",
  "vault-reaper.ts",
];
const moduleOwner = "imports/import-session/import-session.module.ts";
const rawOwner = "imports/import-session/import-session.raw-executions.ts";

function gateFactory(node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const properties = new Map(
    node.properties
      .filter(ts.isPropertyAssignment)
      .map((p) => [p.name.getText(), p.initializer]),
  );
  const factory = properties.get("useFactory");
  const inject = properties.get("inject");
  if (
    properties.size !== 3 ||
    properties.get("provide")?.getText() !== "IMPORT_VAULT_GATE" ||
    !inject ||
    !ts.isArrayLiteralExpression(inject) ||
    inject.elements.map((e) => e.getText()).join(",") !==
      "PrismaService,IMPORT_SESSION_CLOCK" ||
    !factory ||
    !ts.isArrowFunction(factory) ||
    factory.parameters.length !== 2
  )
    return false;
  const body = ts.isBlock(factory.body)
    ? factory.body.statements.length === 1 &&
      ts.isReturnStatement(factory.body.statements[0])
      ? factory.body.statements[0].expression
      : undefined
    : factory.body;
  return (
    !!body &&
    ts.isCallExpression(body) &&
    body.expression.getText() === "createImportVaultGate" &&
    body.arguments.map((a) => a.getText()).join(",") ===
      `${factory.parameters[0].name.getText()},${factory.parameters[1].name.getText()},process.env,process.cwd()`
  );
}

function workflowFactory(node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 3)
    return false;
  const entries = new Map(
    node.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => [property.name.getText(), property.initializer]),
  );
  const inject = entries.get("inject");
  const factory = entries.get("useFactory");
  if (
    entries.get("provide")?.getText() !== "ImportSessionWorkflowService" ||
    !inject ||
    !ts.isArrayLiteralExpression(inject) ||
    inject.elements.map((entry) => entry.getText()).join(",") !==
      "PrismaService,IMPORT_SESSION_CLOCK,IMPORT_SESSION_CAPABILITY,IMPORT_SESSION_GRANT_VERIFIER,CARD_PURCHASE_BATCH_PORT,IMPORT_VAULT_GATE,ImportRawExecutions" ||
    !factory ||
    !ts.isArrowFunction(factory) ||
    factory.parameters.length !== 7
  )
    return false;
  return (
    ts.isNewExpression(factory.body) &&
    factory.body.expression.getText() === "ImportSessionWorkflowService" &&
    factory.body.arguments?.map((argument) => argument.getText()).join(",") ===
      factory.parameters.map((parameter) => parameter.name.getText()).join(",")
  );
}

function audit(file: string, source: string): Violation[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2021, true);
  const owner =
    !file.includes("/") || file.startsWith("imports/import-session/vault/")
      ? basename(file)
      : file;
  const violations: Violation[] = [];
  const bootAliases = new Set(["startVaultBoot"]);
  const consumerBindings = new Set<string>();
  const borrowed = new Set(["lockFd"]);
  const add = (rule: string, node: ts.Node) =>
    violations.push({
      rule,
      file,
      at: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
    });
  const importAllowed = (
    module: string,
    name: string,
    typeOnly: boolean,
  ): boolean => {
    switch (basename(module).replace(/\.ts$/, "")) {
      case "vault-boot":
        if (owner === "vault-state.ts")
          return typeOnly
            ? ["VaultBootHandle", "VaultRuntime"].includes(name)
            : name === "startVaultBoot";
        return (
          ["vault-storage.ts", "vault-purger.ts"].includes(owner) &&
          typeOnly &&
          ["VaultBootHandle", "VaultRuntime"].includes(name)
        );
      case "vault-probe":
        return (
          owner === "vault-boot.ts" &&
          !typeOnly &&
          ["collectLockFacts", "collectRootFacts"].includes(name)
        );
      case "vault-durability":
        if (!["vault-boot.ts", "vault-storage.ts"].includes(owner))
          return false;
        return typeOnly
          ? [
              "VaultErrno",
              "FsFailure",
              "FsyncResult",
              "SpaceResult",
              "CleanupError",
            ].includes(name)
          : ["fsyncProbe", "availableBytes", "boundedCode"].includes(name);
      case "vault-fd-registry":
        return (
          (owner === rawOwner && typeOnly && name === "VaultFdLease") ||
          ["vault-storage.ts", "vault-purger.ts"].includes(owner) ||
          (owner === "vault-state.ts" &&
            (typeOnly
              ? ["VaultShutdownResult", "VaultKey"].includes(name)
              : name === "VaultFdRegistry"))
        );
      case "vault-storage":
        return (
          owner === "vault-purger.ts" ||
          (owner === "vault-state.ts" &&
            !typeOnly &&
            ["VaultStorage", "VaultIoError"].includes(name)) ||
          (consumers.includes(owner) &&
            (typeOnly
              ? [
                  "VaultDeclaredMime",
                  "VaultUploadClaim",
                  "StoredVaultUpload",
                  "VaultArtifactRead",
                ].includes(name)
              : ["VaultIoError", "MIME_FORMAT"].includes(name)))
        );
      case "vault-purger":
        return (
          (owner === "vault-reaper.ts" &&
            typeOnly &&
            ["VaultPurgeTarget", "VaultPurgeResult"].includes(name)) ||
          (owner === "vault-state.ts" &&
            (typeOnly
              ? ["VaultPurgeTarget", "VaultPurgeResult"].includes(name)
              : name === "PurgeCoordinator"))
        );
      case "vault-state":
        if (
          owner !== moduleOwner &&
          !consumers.includes(owner) &&
          ![
            "imports/import-session/import-session.service.ts",
            "imports/import-session/import-session-workflow.service.ts",
            "imports/import-session/import-session.extraction.service.ts",
            rawOwner,
          ].includes(owner)
        )
          return false;
        return typeOnly
          ? name === "ImportVaultGate"
          : name === "IMPORT_VAULT_GATE" ||
              (owner === moduleOwner && name === "createImportVaultGate");
      default:
        return true;
    }
  };
  const visit = (node: ts.Node, inFunction = false) => {
    const nested = inFunction || ts.isFunctionLike(node);
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const part of bindings.elements) {
          const name = (part.propertyName ?? part.name).text;
          if (
            owner === moduleOwner &&
            consumers.includes(basename(module).replace(/\.ts$/, "") + ".ts") &&
            !clause?.isTypeOnly &&
            !part.isTypeOnly
          )
            consumerBindings.add(part.name.text);
          if (name === "startVaultBoot") bootAliases.add(part.name.text);
          if (
            !importAllowed(
              module,
              name,
              !!clause?.isTypeOnly || part.isTypeOnly,
            )
          )
            add("import-lease", node);
        }
      } else if (!importAllowed(module, "*", !!clause?.isTypeOnly))
        add("import-lease", node);
      if (
        clause?.name &&
        !importAllowed(module, "default", !!clause.isTypeOnly)
      )
        add("import-lease", node);
      if (
        foundation.includes(owner) &&
        (/(?:^node:)?(?:child_process|http|https|net|tls|dns|worker_threads)$/.test(
          module,
        ) ||
          /parsers|gemini|google|xlsx|pdf-parse|agent-tools|@nestjs\/(?:core|schedule)/.test(
            module,
          ))
      )
        add("inactive-import", node);
      if (
        owner === "vault-state.ts" &&
        /^(?:node:)?fs(?:\/promises)?$/.test(module)
      )
        add("inactive-import", node);
      if (
        foundation.includes(owner) &&
        module === "@nestjs/common" &&
        bindings &&
        ts.isNamedImports(bindings)
      ) {
        for (const part of bindings.elements) {
          if ((part.propertyName ?? part.name).text !== "Logger")
            add("provider", node);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (
        ts.isIdentifier(node.name) &&
        [...borrowed].some((name) =>
          new RegExp(`\\b${name}\\b`).test(node.initializer!.getText(ast)),
        )
      )
        borrowed.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const part of node.name.elements) {
          if ((part.propertyName ?? part.name).getText(ast) === "lockFd")
            borrowed.add(part.name.getText(ast));
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      /vault-(boot|probe|durability|storage|purger|fd-registry|state)/.test(
        node.moduleSpecifier.getText(ast),
      )
    )
      add("re-export", node);
    if (
      ts.isImportEqualsDeclaration(node) &&
      /vault-/.test(node.moduleReference.getText(ast))
    )
      add("dynamic-import", node);
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const name = ts.isIdentifier(expr)
        ? expr.text
        : ts.isPropertyAccessExpression(expr)
          ? expr.name.text
          : "";
      if (bootAliases.has(name) && owner !== "vault-state.ts")
        add("boot-caller", node);
      if (name === "createImportVaultGate") {
        let ancestor: ts.Node | undefined = node.parent;
        while (ancestor && !ts.isObjectLiteralExpression(ancestor))
          ancestor = ancestor.parent;
        if (owner !== moduleOwner || !ancestor || !gateFactory(ancestor))
          add("factory-caller", node);
      }
      if (owner === "vault-state.ts" && !nested) {
        const symbol =
          name === "Symbol" &&
          ts.isIdentifier(expr) &&
          (node.arguments.length === 0 ||
            (node.arguments.length === 1 &&
              ts.isStringLiteral(node.arguments[0]))) &&
          ts.isVariableDeclaration(node.parent) &&
          node.parent.name.getText(ast) === "IMPORT_VAULT_GATE";
        if (!symbol) add("import-time-effect", node);
      }
      if (
        (name === "require" || expr.kind === ts.SyntaxKind.ImportKeyword) &&
        (foundation.includes(owner) ||
          /vault-/.test(node.arguments[0]?.getText(ast) ?? ""))
      )
        add("dynamic-import", node);
      if (name === "eraseCaptured" && owner !== "vault-purger.ts")
        add("destructive-owner", node);
      if (
        name === "exit" &&
        owner !== "vault-storage.ts" &&
        owner !== rawOwner &&
        /(?:lease|handle|admission)/i.test(expr.getText(ast))
      )
        add("exit-owner", node);
      if (
        [
          "close",
          "closeSync",
          "open",
          "openSync",
          "rm",
          "unlink",
          "rename",
        ].includes(name) &&
        node.arguments.some((arg) => {
          const text = arg.getText(ast);
          return (
            text.includes(".lock") ||
            [...borrowed].some((alias) =>
              new RegExp(`\\b${alias}\\b`).test(text),
            )
          );
        })
      )
        add("borrowed-lock", node);
      if (
        [
          "vault-probe.ts",
          "vault-lock.ts",
          "vault-root.ts",
          "vault-boot.ts",
        ].includes(owner) &&
        [
          "mkdir",
          "rm",
          "rmdir",
          "unlink",
          "rename",
          "write",
          "writeFile",
          "appendFile",
          "truncate",
          "close",
          "closeSync",
        ].includes(name)
      )
        add("collector-mutation", node);
      if (foundation.includes(owner)) {
        if (!nested) add("import-time-effect", node);
        if (
          name.endsWith("Sync") ||
          ["setInterval", "fetch", "eval"].includes(name)
        )
          add("inactive-call", node);
        if (
          name === "runImportSessionWrite" ||
          name === "mintImportAuthContext"
        ) {
          if (owner === "vault-purger.ts")
            add("fabricated-request-authority", node);
        }
      }
    }
    if (foundation.includes(owner) && ts.isNewExpression(node) && !nested) {
      const pureRegExp =
        ts.isIdentifier(node.expression) &&
        node.expression.text === "RegExp" &&
        node.arguments?.length === 1 &&
        (ts.isStringLiteral(node.arguments[0]) ||
          node.arguments[0].getText(ast) ===
            "IMPORT_SESSION_PRIMITIVES.idPattern");
      if (!pureRegExp) add("import-time-effect", node);
    }
    if (
      ts.isNewExpression(node) &&
      [
        "VaultFdRegistry",
        "VaultStorage",
        "PurgeCoordinator",
        "ImportVaultGate",
      ].includes(node.expression.getText(ast)) &&
      owner !== "vault-state.ts"
    )
      add("assembly-owner", node);
    if (owner === "vault-state.ts" && ts.isNewExpression(node) && !nested)
      add("import-time-effect", node);
    if (
      foundation.includes(owner) &&
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(ast) === "process" &&
      node.name.text === "env"
    )
      add("raw-environment", node);
    if (
      ts.isPropertyAssignment(node) &&
      [
        "provide",
        "useClass",
        "useFactory",
        "useValue",
        "providers",
        "exports",
      ].includes(node.name.getText(ast))
    ) {
      const allowedFactory =
        owner === moduleOwner &&
        (gateFactory(node.parent) || workflowFactory(node.parent));
      const allowedProviders =
        owner === moduleOwner &&
        node.name.getText(ast) === "providers" &&
        ts.isArrayLiteralExpression(node.initializer) &&
        node.initializer.elements
          .filter((e) => /Vault|IMPORT_VAULT/.test(e.getText(ast)))
          .every(
            (e) =>
              gateFactory(e) ||
              workflowFactory(e) ||
              (ts.isIdentifier(e) && consumerBindings.has(e.text)),
          );
      if (
        /Vault|IMPORT_VAULT/.test(node.initializer.getText(ast)) &&
        !allowedFactory &&
        !allowedProviders
      )
        add("provider", node);
    }
    ts.forEachChild(node, (child) => {
      const instanceInitializer =
        ts.isPropertyDeclaration(node) &&
        !node.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
        ) &&
        child === node.initializer;
      const evaluatedName =
        ts.isComputedPropertyName(child) || ts.isDecorator(child);
      visit(child, evaluatedName ? inFunction : instanceInitializer || nested);
    });
  };
  visit(ast);
  return violations;
}

function productionSources(dir: string): { file: string; text: string }[] {
  const result: { file: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        !["node_modules", "dist", "test-utils", "__tests__"].includes(
          entry.name,
        )
      )
        result.push(...productionSources(path));
    } else if (
      entry.name.endsWith(".ts") &&
      !/\.(spec|test)\.ts$/.test(entry.name)
    )
      result.push({ file: path, text: readFileSync(path, "utf8") });
  }
  return result;
}

describe("P05 independent inactive import/ownership AST controls", () => {
  it("permits only the exact RAW owner to use its lease, not construct foundation", () => {
    expect(audit(rawOwner, 'import type { VaultFdLease } from "./vault/vault-fd-registry"; function close() { entry.lease.exit(); }')).toEqual([]);
    for (const owner of ["other/import-session.raw-executions.ts", "import-session.raw-executions.ts"]) {
      expect(audit(owner, 'import type { VaultFdLease } from "./vault/vault-fd-registry"; function close() { entry.lease.exit(); }').length).toBeGreaterThan(0);
    }
    expect(audit(rawOwner, 'import { VaultFdRegistry } from "./vault/vault-fd-registry"; function build() { return new VaultFdRegistry(); }').length).toBeGreaterThan(0);
  });
  it.each([
    'import type { VaultPurgeTarget, VaultPurgeResult } from "./vault-purger";',
    'import { type VaultPurgeTarget, type VaultPurgeResult } from "./vault-purger";',
  ])(
    "G1 CONTROL reaper may import only the two named purge types: %s",
    (source) => {
      expect(audit("vault-reaper.ts", source)).toEqual([]);
    },
  );

  it.each([
    'import { VaultPurgeTarget } from "./vault-purger";',
    'import { VaultPurgeResult } from "./vault-purger";',
    'import type { PurgeCoordinator } from "./vault-purger";',
    'import { PurgeCoordinator } from "./vault-purger";',
    'import type * as purger from "./vault-purger";',
    'export type { VaultPurgeTarget } from "./vault-purger";',
    "function build() { return new PurgeCoordinator(db, clock, boot, registry, storage, 37); }",
  ])(
    "G1 CONTROL reaper type allowance does not permit runtime/construction/export: %s",
    (source) => {
      expect(audit("vault-reaper.ts", source).length).toBeGreaterThan(0);
    },
  );

  it.each([
    [
      "vault-state.ts",
      'export const IMPORT_VAULT_GATE = Symbol("IMPORT_VAULT_GATE");',
    ],
    [
      "vault-state.ts",
      'import { startVaultBoot } from "./vault-boot"; function create() { return startVaultBoot(env, roots); }',
    ],
    [
      "vault-state.ts",
      'import { VaultFdRegistry } from "./vault-fd-registry"; import { VaultStorage } from "./vault-storage"; import { PurgeCoordinator } from "./vault-purger"; function create() { new VaultFdRegistry(); new VaultStorage(boot, registry, clock); new PurgeCoordinator(db, clock, boot, registry, storage, drain); }',
    ],
    [
      moduleOwner,
      'import { IMPORT_VAULT_GATE, createImportVaultGate } from "./vault/vault-state"; const provider = { provide: IMPORT_VAULT_GATE, inject: [PrismaService, IMPORT_SESSION_CLOCK], useFactory: (db, clock) => createImportVaultGate(db, clock, process.env, process.cwd()) };',
    ],
    ...consumers.map((file) => [
      file,
      'import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault-state";',
    ]),
    [
      moduleOwner,
      'import { VaultReaper } from "./vault/vault-reaper"; const meta = { providers: [VaultReaper] };',
    ],
  ])("CONTROL exact lifecycle allowance %s", (file, source) => {
    expect(audit(file, source)).toEqual([]);
  });

  it.each([
    [
      "unrelated/vault-state.ts",
      'import { startVaultBoot } from "./vault-boot";',
      "import-lease",
    ],
    [
      "import-upload.service.ts",
      'import { createImportVaultGate } from "./vault-state";',
      "import-lease",
    ],
    [
      "import-attachment.controller.ts",
      'import { IMPORT_VAULT_GATE } from "./vault-state";',
      "import-lease",
    ],
    [
      "vault-state.ts",
      'import { collectLockFacts } from "./vault-probe";',
      "import-lease",
    ],
    [
      "vault-state.ts",
      'import type { LockFacts } from "./vault-probe";',
      "import-lease",
    ],
    [
      "vault-state.ts",
      "function close() { fs.close(runtime.config.lockFd); }",
      "borrowed-lock",
    ],
    [
      "vault-state.ts",
      'import { promises } from "node:fs";',
      "inactive-import",
    ],
    [
      "vault-state.ts",
      "const running = startVaultBoot(env, roots);",
      "import-time-effect",
    ],
    [
      "vault-state.ts",
      'export const IMPORT_VAULT_GATE = Symbol.for("IMPORT_VAULT_GATE");',
      "import-time-effect",
    ],
    [
      "vault-state.ts",
      "const registry = new VaultFdRegistry();",
      "import-time-effect",
    ],
    [
      moduleOwner,
      "const another = createImportVaultGate(db, clock, process.env, process.cwd());",
      "factory-caller",
    ],
    [
      "import-upload.service.ts",
      "function construct() { return new VaultStorage(boot, registry, clock); }",
      "assembly-owner",
    ],
    [
      moduleOwner,
      'const bad = { provide: "IMPORT_VAULT_GATE", useFactory: createImportVaultGate };',
      "provider",
    ],
    [
      moduleOwner,
      "const bad = { provide: IMPORT_VAULT_GATE, inject: [], useFactory: () => createImportVaultGate(db, clock, env, cwd) };",
      "provider",
    ],
    [moduleOwner, "const bad = { exports: [IMPORT_VAULT_GATE] };", "provider"],
    [
      "other.module.ts",
      "const bad = { provide: IMPORT_VAULT_GATE, inject: [PrismaService, IMPORT_SESSION_CLOCK], useFactory: (db, clock) => createImportVaultGate(db, clock, process.env, process.cwd()) };",
      "provider",
    ],
  ])(
    "CONTROL lifecycle allowance is not a blanket exception: %s",
    (file, source, rule) => {
      expect(audit(file, source).map((v) => v.rule)).toContain(rule);
    },
  );
  it.each([
    "class Deferred { cache = new Map(); owners = new Set(); }",
    "const pattern = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);",
    'const pattern = new RegExp("literal");',
  ])("CONTROL deferred fields or pure pattern initialization: %s", (source) => {
    expect(audit("vault-storage.ts", source)).toEqual([]);
  });

  it.each([
    "const cache = new Map();",
    "class Static { static cache = new Map(); }",
    "class Static { static fd = fs.open(path); }",
    "class Computed { [fs.open(path)] = new Map(); }",
    "class Computed { [fs.open(path)]() {} }",
    "class Static { static { fs.open(path); } }",
    "const pattern = new RegExp(readPattern());",
    "class Deferred { cache = new Map(); } new Deferred();",
  ])("CONTROL rejects real module/static/computed execution: %s", (source) => {
    expect(
      audit("vault-storage.ts", source).map((failure) => failure.rule),
    ).toContain("import-time-effect");
  });

  it.each([
    [
      "vault-storage.ts",
      'import type { VaultBootHandle, VaultRuntime } from "./vault-boot";',
    ],
    ["vault-purger.ts", 'import { type VaultBootHandle } from "./vault-boot";'],
    [
      "vault-storage.ts",
      'import { fsyncProbe, availableBytes, boundedCode, type VaultErrno } from "./vault-durability";',
    ],
    [
      "vault-boot.ts",
      'import { collectLockFacts, collectRootFacts } from "./vault-probe";',
    ],
    [
      "vault-purger.ts",
      "function erase() { return storage.eraseCaptured(capture); }",
    ],
    ["vault-storage.ts", "function end() { lease.exit(); }"],
  ])("CONTROL permitted lease %s: %s", (file, text) => {
    expect(audit(file, text)).toEqual([]);
  });

  it.each([
    [
      "unrelated/vault-storage.ts",
      'import type { VaultBootHandle } from "./vault-boot";',
      "import-lease",
    ],
    [
      "unrelated.ts",
      'import type { VaultBootHandle } from "./vault-boot";',
      "import-lease",
    ],
    [
      "vault-storage.ts",
      'import { VaultBootHandle } from "./vault-boot";',
      "import-lease",
    ],
    [
      "vault-purger.ts",
      'import type { VaultReason } from "./vault-boot";',
      "import-lease",
    ],
    [
      "vault-storage.ts",
      'import * as boot from "./vault-boot";',
      "import-lease",
    ],
    [
      "vault-storage.ts",
      'import type { LockFacts } from "./vault-probe";',
      "import-lease",
    ],
    [
      "vault-purger.ts",
      'import { fsyncProbe } from "./vault-durability";',
      "import-lease",
    ],
    [
      "unrelated.ts",
      'import type { VaultErrno } from "./vault-durability";',
      "import-lease",
    ],
    [
      "vault-storage.ts",
      'import { collectLockFacts } from "./vault-probe";',
      "import-lease",
    ],
    [
      "app.module.ts",
      'import { VaultStorage } from "./vault-storage";',
      "import-lease",
    ],
    [
      "app.module.ts",
      'import type { PurgeCoordinator } from "./vault-purger";',
      "import-lease",
    ],
    [
      "vault-storage.ts",
      'import { startVaultBoot as launch } from "./vault-boot"; function run() { launch(env, roots); }',
      "boot-caller",
    ],
    [
      "main.ts",
      "function run() { boot.startVaultBoot(env, roots); }",
      "boot-caller",
    ],
    [
      "app.module.ts",
      'const provider = { provide: "IMPORT_VAULT_GATE", useFactory: bootFactory };',
      "provider",
    ],
    [
      "vault-storage.ts",
      'import { Injectable } from "@nestjs/common";',
      "provider",
    ],
    [
      "vault-probe.ts",
      "function mutate() { fs.unlink(path); }",
      "collector-mutation",
    ],
    [
      "vault-probe.ts",
      "function mutate() { fs.close(fd); }",
      "collector-mutation",
    ],
    [
      "vault-storage.ts",
      "function close() { fsp.close(runtime.config.lockFd); }",
      "borrowed-lock",
    ],
    [
      "vault-storage.ts",
      "function close() { const { lockFd: inherited } = runtime.config; fs.close(inherited); }",
      "borrowed-lock",
    ],
    [
      "vault-storage.ts",
      'function open() { return fsp.open(root + "/.lock"); }',
      "borrowed-lock",
    ],
    [
      "vault-storage.ts",
      "function root() { return process.env.VAULT_DIR; }",
      "raw-environment",
    ],
    [
      "vault-storage.ts",
      'import { spawn } from "node:child_process";',
      "inactive-import",
    ],
    [
      "vault-storage.ts",
      'import { parse } from "credit-card/parsers";',
      "inactive-import",
    ],
    [
      "vault-storage.ts",
      "const timer = setTimeout(work, 20);",
      "import-time-effect",
    ],
    [
      "vault-purger.ts",
      "function work() { return runImportSessionWrite(db, clock, mintImportAuthContext(data), cleanup); }",
      "fabricated-request-authority",
    ],
    [
      "vault-fd-registry.ts",
      "function finish() { lease.exit(); }",
      "exit-owner",
    ],
    [
      "vault-storage.ts",
      "function bad() { storage.eraseCaptured(c); }",
      "destructive-owner",
    ],
    [
      "other.ts",
      'export { VaultStorage } from "./vault-storage";',
      "re-export",
    ],
    ["other.ts", 'const boot = require("./vault-boot");', "dynamic-import"],
  ])("CONTROL catches %s (%s)", (file, source, rule) => {
    expect(audit(file, source).map((v) => v.rule)).toContain(rule);
  });

  it("CONTROL scanner ignores comments and strings, not type imports", () => {
    expect(
      audit(
        "vault-storage.ts",
        '// import { startVaultBoot } from "./vault-boot"\nconst text = "process.env.VAULT_DIR; lease.exit(); fs.close(lockFd)";',
      ),
    ).toEqual([]);
  });

  it("F21 all actual production callers honor the exact inactive named leases", () => {
    const root = join(__dirname, "../../..");
    const violations = productionSources(root).flatMap(({ file, text }) =>
      audit(relative(root, file), text),
    );
    expect(violations).toEqual([]);
  });

  it("F21 foundation exists and has no provider, raw env, collector, lock-close or boot-caller escape", () => {
    loadRegistry();
    loadStorage();
    loadPurger();
    for (const name of foundation)
      expect(audit(name, readFileSync(join(__dirname, name), "utf8"))).toEqual(
        [],
      );
  });
});
