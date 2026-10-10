import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { ConciliacaoModule } from "../../conciliacao/conciliacao.module";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { ExpenseModule } from "../../expense/expense.module";
import { ExpenseService } from "../../expense/expense.service";
import { PrismaModule } from "../../prisma/prisma.module";
import { PrismaService } from "../../prisma/prisma.service";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import { CARD_PURCHASE_BATCH_PORT } from "./card-purchase-batch.port";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import { RuntimeUiGrantVerifier } from "./import-session-ui-grant";
import {
  DefaultImportSessionCapability,
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  IMPORT_SESSION_GRANT_VERIFIER,
  type ImportSessionCapability,
} from "./import-session.capability";
import { ImportSessionModule } from "./import-session.module";
import { ImportChatGuard } from "./import-chat.guard";
import { ImportChatBridge } from "./import-chat.bridge";
import { ImportSessionController } from "./import-session.controller";
import { ImportSessionService } from "./import-session.service";
import { IMPORT_VAULT_GATE } from "./vault/vault-state";
import {
  ImportRawExecutions,
  IMPORT_X2_NATIVE_CONFIG,
} from "./import-session.raw-executions";
import { ImportSessionExtractionService } from "./import-session.extraction.service";
import { VaultReaper } from "./vault/vault-reaper";
import {
  IMPORT_INTERPRETATION_PROVIDER,
  IMPORT_INTERPRETATION_QUOTA,
} from "./import-session-interpretation.service";
import {
  assertImportSessionOperationAvailable,
  IMPORT_SESSION_WRITES_ENABLED,
  ImportSessionCapabilityDisabledError,
  type ImportSessionOperation,
} from "./import-session.disabled";

/**
 * Baseline P06/P07 or the complete inactive attachment composition, never a partial set.
 * Prospective allowances are not implementation evidence. Writes stay OFF.
 */

const srcRoot = resolve(__dirname, "../..");
const here = __dirname;

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const allSources = walk(srcRoot).filter(
  (file) =>
    file.endsWith(".ts") &&
    !file.endsWith(".spec.ts") &&
    !file.endsWith(".test.ts"),
);
const testUtilPrefix = join(srcRoot, "test-utils");
// Test helpers are not production code, but no production file may depend on them.
const productionFiles = allSources.filter(
  (file) => !file.startsWith(testUtilPrefix),
);
const rel = (file: string): string => relative(srcRoot, file);

describe("kill-switch fails closed", () => {
  it("throws the typed 503 error for every write, and for an unknown operation", () => {
    expect(IMPORT_SESSION_WRITES_ENABLED).toBe(false);
    for (const operation of [
      "CREATE",
      "RESERVE",
      "UPLOAD",
      "FINALIZE_UPLOAD",
      "ANALYZE",
      "EDIT",
      "PREPARE",
      "CHALLENGE",
      "FIRST_CONFIRM",
      "EXECUTE_UNAPPLIED",
      // A future untyped adapter (or a typo) must not slip through as "allowed".
      "SOMETHING_NEW",
      "",
      "constructor",
      "toString",
      "__proto__",
    ] as ImportSessionOperation[]) {
      let thrown: unknown;
      try {
        assertImportSessionOperationAvailable(operation);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ImportSessionCapabilityDisabledError);
      expect(thrown).toMatchObject({
        code: "CAPABILITY_DISABLED",
        status: 503,
        retryable: true,
        sessionId: null,
        currentRevision: null,
        message: "CAPABILITY_DISABLED",
      });
    }
  });

  it("keeps recovery/read/cancel/reap operations unblocked (exactly seven)", () => {
    const recovery = [
      "READ_SESSION",
      "READ_RESULT",
      "READ_PRIVATE_EXISTING",
      "CANCEL",
      "REPLAY_CONFIRMATION",
      "REPLAY_APPLIED_RECEIPT",
      "REAP",
    ] as ImportSessionOperation[];
    expect(recovery).toHaveLength(7);
    for (const operation of recovery)
      expect(() =>
        assertImportSessionOperationAvailable(operation),
      ).not.toThrow();
  });
});

describe("P06/P07 private surface (twelve routes, boot-snapshotted intake)", () => {
  const ownFiles = productionFiles.filter((file) => file.startsWith(here));
  const source = (name: string): string =>
    readFileSync(join(here, name), "utf8");
  const ownWith = (pattern: RegExp): string[] =>
    ownFiles
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(here, file))
      .sort();
  const attachmentFiles = [
    "vault/import-attachment.controller.ts",
    "vault/import-content.service.ts",
    "vault/import-upload.service.ts",
    "vault/vault-reaper.ts",
    "vault/vault-state.ts",
  ];
  const withAttachments = ownFiles.some(
    (file) => relative(here, file) === "vault/vault-state.ts",
  );

  it("requires the concrete adapter, workflow and search alongside recovery and the writer", () => {
    const baseline = [
      "card-purchase-batch.adapter.ts",
      "card-purchase-batch.port.ts",
      "import-chat-answer.ts",
      "import-chat.admission.ts",
      "import-chat.bridge.ts",
      "import-chat.guard.ts",
      "import-current-lot.ts",
      "import-session-documentary.commands.ts",
      "import-session-interpretation.service.ts",
      "import-session-interpretation.ts",
      "import-session-operation-throttle.guard.ts",
      "import-session-workflow.service.ts",
      "import-session-ui-grant.ts",
      "import-session-ui.guard.ts",
      "import-session.auth.ts",
      "import-session.capability.ts",
      "import-session.contract.ts",
      "import-session.controller.ts",
      "import-session.cursor.ts",
      "import-session.disabled.ts",
      "import-session.errors.ts",
      "import-session.intake-gate.ts",
      "import-session.list.ts",
      "import-session.module.ts",
      "import-session.observation.ts",
      "import-session.preparation.ts",
      "import-session.projection.ts",
      "import-session.search.ts",
      "import-session.service.ts",
      "import-session.validation.ts",
      "import-session.writer.ts",
      "vault/vault-framing.ts", // B2a slice 1a: pure upload framing + pre-parser middleware, nothing else
      "vault/vault-lock.ts", // B2a slice 2: pure decodeLinuxDev (uint64 st_dev), no fs
      "vault/vault-probe.ts", // B2a slice 4: inert real-fact collector (node:fs and node:path only), no timer/wiring
      "vault/vault-root.ts", // B2a slice 2: pure headroomSatisfied (BigInt) + classifyRootFacts (root policy over collected facts), no fs
      "vault/vault.config.ts", // B2a slice 1b: pure syntactic config (env in, verdict out), no env/fs reads of its own
    ].map((name) => `imports/import-session/${name}`);
    const future = [
      ...baseline,
      "imports/import-session/vault/vault-boot.ts",
      "imports/import-session/vault/vault-durability.ts",
    ].sort();
    const foundation = [
      ...future,
      "imports/import-session/vault/vault-fd-registry.ts",
      "imports/import-session/vault/vault-storage.ts",
      "imports/import-session/vault/vault-purger.ts",
    ].sort();
    expect(foundation.filter((path) => !future.includes(path))).toEqual([
      "imports/import-session/vault/vault-fd-registry.ts",
      "imports/import-session/vault/vault-purger.ts",
      "imports/import-session/vault/vault-storage.ts",
    ]);
    expect(attachmentFiles).toEqual([
      "vault/import-attachment.controller.ts",
      "vault/import-content.service.ts",
      "vault/import-upload.service.ts",
      "vault/vault-reaper.ts",
      "vault/vault-state.ts",
    ]);
    const complete = [
      ...foundation,
      ...attachmentFiles.map((name) => `imports/import-session/${name}`),
    ].sort();
    const extracted = [
      ...complete,
      "imports/import-session/import-session.extraction.ts",
      "imports/import-session/import-session.extraction.service.ts",
    ].sort();
    const accepted = [
      foundation,
      complete,
      extracted,
      [
        ...extracted,
        "imports/import-session/import-session.declarations.ts",
        "imports/import-session/import-session.raw-executions.ts",
      ].sort(),
    ];
    expect(accepted).not.toContainEqual(
      [
        ...complete,
        "imports/import-session/import-session.declarations.ts",
      ].sort(),
    );
    expect(accepted).not.toContainEqual(
      [
        ...complete,
        "imports/import-session/import-session.declarations.ts",
        "imports/import-session/import-session.extraction.ts",
      ].sort(),
    );
    expect(accepted).not.toContainEqual(
      [
        ...complete,
        "imports/import-session/import-session.declarations.ts",
        "imports/import-session/import-session.extraction.service.ts",
      ].sort(),
    );
    for (const file of [
      "import-session.extraction.ts",
      "import-session.extraction.service.ts",
    ])
      expect(accepted).not.toContainEqual(
        [...complete, `imports/import-session/${file}`].sort(),
      );
    expect(accepted).not.toContainEqual(
      [...future, "imports/import-session/vault/vault-storage.ts"].sort(),
    );
    expect(accepted).not.toContainEqual(
      [...foundation, "imports/import-session/vault/vault-reaper.ts"].sort(),
    );
    for (const name of attachmentFiles) {
      expect(accepted).not.toContainEqual(
        [...foundation, `imports/import-session/${name}`].sort(),
      );
      expect(accepted).not.toContainEqual(
        complete.filter((file) => file !== `imports/import-session/${name}`),
      );
    }
    expect(accepted).not.toContainEqual(
      [...complete, "imports/import-session/vault/vault-scheduler.ts"].sort(),
    );
    expect(accepted).toContainEqual(ownFiles.map(rel).sort());
  });

  it("preserves the two real financial factories; only the complete composition adds the private gate", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, ImportSessionModule),
    ).toEqual([PrismaModule, ExpenseModule, ConciliacaoModule]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, ImportSessionModule) ?? [],
    ).toEqual([ImportChatGuard, ImportChatBridge]);
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ImportSessionModule,
    );
    const factories = providers.filter(
      (provider) =>
        typeof provider === "object" &&
        provider !== null &&
        "useFactory" in provider,
    );
    const expected: unknown[] = [
      {
        provide: IMPORT_INTERPRETATION_PROVIDER,
        useFactory: expect.any(Function),
      },
      {
        provide: IMPORT_INTERPRETATION_QUOTA,
        inject: [PrismaService, IMPORT_SESSION_CLOCK],
        useFactory: expect.any(Function),
      },
      {
        provide: IMPORT_SESSION_CAPABILITY,
        useFactory: expect.any(Function),
      },
      {
        provide: CARD_PURCHASE_BATCH_PORT,
        inject: [ExpenseService, ConciliacaoService, IMPORT_SESSION_CLOCK],
        useFactory: expect.any(Function),
      },
      {
        provide: ImportSessionWorkflowService,
        inject: [
          PrismaService,
          IMPORT_SESSION_CLOCK,
          IMPORT_SESSION_CAPABILITY,
          IMPORT_SESSION_GRANT_VERIFIER,
          CARD_PURCHASE_BATCH_PORT,
          IMPORT_VAULT_GATE,
          ImportRawExecutions,
        ],
        useFactory: expect.any(Function),
      },
    ];
    const controllers: unknown[] = [ImportSessionController];
    if (withAttachments) {
      const { IMPORT_VAULT_GATE } = jest.requireActual<{
        IMPORT_VAULT_GATE: symbol;
      }>("./vault/vault-state");
      expect(typeof IMPORT_VAULT_GATE).toBe("symbol");
      expected.push({
        provide: IMPORT_VAULT_GATE,
        inject: [PrismaService, IMPORT_SESSION_CLOCK],
        useFactory: expect.any(Function),
      });
      const { ImportAttachmentController } = jest.requireActual<{
        ImportAttachmentController: unknown;
      }>("./vault/import-attachment.controller");
      controllers.push(ImportAttachmentController);
    }
    expect(factories).toEqual(expected);
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ImportSessionModule),
    ).toEqual(controllers);
    expect(ownWith(/\bIMPORT_VAULT_STATE\b/)).toEqual([]);
  });

  it("resolves the real private adapter and workflow with the same dependencies and default OFF", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ImportSessionModule],
    }).compile();
    try {
      expect(moduleRef.get(ImportSessionService)).toBeInstanceOf(
        ImportSessionService,
      );
      const port = moduleRef.get<CardPurchaseBatchAdapter>(
        CARD_PURCHASE_BATCH_PORT,
      );
      const workflow = moduleRef.get(ImportSessionWorkflowService);
      const clock = moduleRef.get(IMPORT_SESSION_CLOCK);
      const capability = moduleRef.get<DefaultImportSessionCapability>(
        IMPORT_SESSION_CAPABILITY,
      );
      const verifier = moduleRef.get(IMPORT_SESSION_GRANT_VERIFIER);
      expect(port).toBeInstanceOf(CardPurchaseBatchAdapter);
      expect(workflow).toBeInstanceOf(ImportSessionWorkflowService);
      expect(capability).toBeInstanceOf(DefaultImportSessionCapability);
      expect(capability.writesEnabled()).toBe(false);
      expect(capability.newImportFormats()).toEqual([]);
      expect(moduleRef.get(IMPORT_X2_NATIVE_CONFIG)).toBeNull();
      const raw = moduleRef.get(ImportRawExecutions);
      expect(raw).toBeInstanceOf(ImportRawExecutions);
      expect(
        Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ImportSessionModule),
      ).toContainEqual({ provide: IMPORT_X2_NATIVE_CONFIG, useValue: null });
      for (const consumer of [
        moduleRef.get(ImportSessionService),
        moduleRef.get(ImportSessionExtractionService),
        workflow,
        moduleRef.get(VaultReaper),
      ])
        expect(Reflect.get(consumer, "raw")).toBe(raw);
      expect(verifier).toBeInstanceOf(RuntimeUiGrantVerifier);
      expect(Reflect.get(port, "expenses")).toBe(moduleRef.get(ExpenseService));
      expect(Reflect.get(port, "conciliacao")).toBe(
        moduleRef.get(ConciliacaoService),
      );
      expect(Reflect.get(port, "clock")).toBe(clock);
      expect(Reflect.get(workflow, "prisma")).toBe(
        moduleRef.get(PrismaService),
      );
      expect(Reflect.get(workflow, "clock")).toBe(clock);
      expect(Reflect.get(workflow, "capability")).toBe(capability);
      expect(Reflect.get(workflow, "verifier")).toBe(verifier);
      expect(Reflect.get(workflow, "batches")).toBe(port);
    } finally {
      await moduleRef.close();
    }
  });

  it("production capability factory snapshots exact csv and rejects malformed boot input", async () => {
    const providers: Array<{
      provide?: unknown;
      useFactory?: () => ImportSessionCapability;
    }> = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ImportSessionModule);
    const provider = providers.find(
      (candidate) => candidate.provide === IMPORT_SESSION_CAPABILITY,
    );
    expect(provider?.useFactory).toEqual(expect.any(Function));
    if (!provider?.useFactory)
      throw new Error("missing production capability factory");
    const previous = process.env.IMPORT_SESSION_INTAKE_MODE;
    try {
      process.env.IMPORT_SESSION_INTAKE_MODE = "csv";
      const captured = provider.useFactory();
      process.env.IMPORT_SESSION_INTAKE_MODE = "off";
      expect(captured.writesEnabled()).toBe(true);
      expect(captured.newImportFormats()).toEqual(["CSV"]);

      process.env.IMPORT_SESSION_INTAKE_MODE = "CSV";
      expect(() => provider.useFactory?.()).toThrow(TypeError);
      await expect(
        Test.createTestingModule({
          imports: [ImportSessionModule],
        }).compile(),
      ).rejects.toThrow(TypeError);
    } finally {
      if (previous === undefined) delete process.env.IMPORT_SESSION_INTAKE_MODE;
      else process.env.IMPORT_SESSION_INTAKE_MODE = previous;
    }
  });

  it("confines every Nest decorator to its own boundary file", () => {
    const controllers = withAttachments
      ? [
          "import-session.controller.ts",
          "vault/import-attachment.controller.ts",
        ]
      : ["import-session.controller.ts"];
    expect(ownWith(/@Controller\b/)).toEqual(controllers);
    expect(ownWith(/@Module\b/)).toEqual(["import-session.module.ts"]);
    expect(ownWith(/@Catch\b/)).toEqual(["import-session.errors.ts"]);
    expect(ownWith(/@(Get|Post|Put|Patch|Delete|Head|Options|All)\(/)).toEqual(
      controllers,
    );
    const injectables = [
      "import-chat.bridge.ts",
      "import-chat.guard.ts",
      "import-session-interpretation.service.ts",
      "import-session-operation-throttle.guard.ts",
      "import-session-ui-grant.ts",
      "import-session-ui.guard.ts",
      "import-session.auth.ts",
      "import-session.extraction.service.ts",
      "import-session.raw-executions.ts",
      "import-session.service.ts",
    ];
    if (withAttachments)
      injectables.push(
        "vault/import-content.service.ts",
        "vault/import-upload.service.ts",
        "vault/vault-reaper.ts",
      );
    expect(ownWith(/@Injectable\b/)).toEqual(injectables);
  });

  it("confines the two pure shared modules to exact dependencies, exports and inactive consumers", () => {
    const consumers = [
      "card-purchase-batch.adapter.ts",
      "import-session-workflow.service.ts",
      "import-session.service.ts",
    ];
    const shared: Record<
      string,
      {
        runtime: string[];
        types: string[];
        dependencies: Record<string, { runtime: string[]; types: string[] }>;
      }
    > = {
      "import-session.preparation": {
        runtime: ["buildImportPreparationPlan"],
        types: [
          "ImportPreparationPlanV1",
          "PreparationObservation",
          "PreparationReference",
          "PreparationSession",
          "ProposalBody",
        ],
        dependencies: {
          "node:crypto": { runtime: ["createHash"], types: [] },
          "@prisma/client": {
            runtime: [],
            types: [
              "ImportArtifact",
              "ImportObservation",
              "ImportSession",
              "ImportSessionArtifact",
            ],
          },
          "@reformaflow/domain": {
            runtime: [
              "IMPORT_SESSION_LIMITS",
              "IMPORT_SESSION_PRIMITIVES",
              "IMPORT_SESSION_PROTOCOL_VERSION",
              "ImportSessionArtifactState",
              "ImportSessionAttachmentState",
              "ImportSessionErrorCode",
            ],
            types: ["ImportSessionProposalV1", "ImportSessionStoredDraftV1"],
          },
          "../../common/canonical": { runtime: ["canonical"], types: [] },
          "./import-session.contract": {
            runtime: [],
            types: ["PreparedCardBatch"],
          },
          "./import-session.errors": {
            runtime: ["ImportSessionCorruptStateError", "ImportSessionError"],
            types: [],
          },
          "./import-session.validation": {
            runtime: [
              "assertProposalDraftReferences",
              "deriveImportSessionEffects",
              "validateProposal",
              "validateStoredDraft",
            ],
            types: [],
          },
        },
      },
      "import-session.observation": {
        runtime: [
          "parseStoredImportObservationEvidence",
          "projectImportObservation",
        ],
        types: ["StoredImportObservationEvidenceV1"],
        dependencies: {
          "@prisma/client": {
            runtime: [],
            types: [
              "ImportObservation",
              "ImportSession",
              "ImportSessionArtifact",
            ],
          },
          "@reformaflow/domain": {
            runtime: [
              "IMPORT_SESSION_LIMITS",
              "IMPORT_SESSION_PRIMITIVES",
              "IMPORT_SESSION_PROTOCOL_VERSION",
              "ImportSessionAmountMeaning",
              "ImportSessionAttachmentState",
              "ImportSessionErrorCode",
              "parseInstallmentDateOnlyUtc",
            ],
            types: [
              "ImportSessionObservationViewV1",
              "ImportSessionStoredDraftV1",
            ],
          },
          "./import-session.errors": {
            runtime: ["ImportSessionCorruptStateError", "ImportSessionError"],
            types: [],
          },
        },
      },
    };
    for (const [name, expected] of Object.entries(shared)) {
      const file = ts.createSourceFile(
        `${name}.ts`,
        source(`${name}.ts`),
        ts.ScriptTarget.Latest,
        true,
      );
      const dependencies: Record<
        string,
        { runtime: string[]; types: string[] }
      > = {};
      const exported = { runtime: [] as string[], types: [] as string[] };
      for (const statement of file.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const clause = statement.importClause;
          const bindings = clause?.namedBindings;
          expect(clause?.name).toBeUndefined();
          expect(bindings && ts.isNamedImports(bindings)).toBe(true);
          const entries = { runtime: [] as string[], types: [] as string[] };
          if (bindings && ts.isNamedImports(bindings)) {
            for (const item of bindings.elements) {
              expect(item.propertyName).toBeUndefined();
              entries[
                clause?.isTypeOnly || item.isTypeOnly ? "types" : "runtime"
              ].push(item.name.text);
            }
          }
          entries.runtime.sort();
          entries.types.sort();
          dependencies[statement.moduleSpecifier.text] = entries;
        }
        if (
          ts.canHaveModifiers(statement) &&
          ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          if (ts.isFunctionDeclaration(statement) && statement.name)
            exported.runtime.push(statement.name.text);
          else if (
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)
          )
            exported.types.push(statement.name.text);
          else throw new Error(`Unapproved export in ${name}`);
        }
      }
      const sortedDependencies = Object.fromEntries(
        Object.entries(expected.dependencies).map(([path, names]) => [
          path,
          {
            runtime: [...names.runtime].sort(),
            types: [...names.types].sort(),
          },
        ]),
      );
      expect(dependencies).toEqual(sortedDependencies);
      expect(exported.runtime.sort()).toEqual([...expected.runtime].sort());
      expect(exported.types.sort()).toEqual([...expected.types].sort());
      expect(source(`${name}.ts`)).not.toMatch(
        /\brequire\(|\bimport\(|\bexport\s+\*|\bnew\s+Date\(\s*\)|Date\.now\(|Math\.random\(/,
      );
    }
    const callSites: Record<string, string[]> = {
      buildImportPreparationPlan: [...consumers],
      parseStoredImportObservationEvidence: [
        ...consumers,
        "import-session.declarations.ts",
        "import-session.extraction.ts",
        "import-session.observation.ts",
      ],
      projectImportObservation: [
        ...consumers,
        "import-session.declarations.ts",
      ],
    };
    for (const path of productionFiles) {
      const file = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const location = relative(here, path);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node)) {
          for (const [name, exports] of Object.entries(shared)) {
            if (node.text !== `./${name}` && !node.text.endsWith(`/${name}`))
              continue;
            expect(
              name === "import-session.observation"
                ? [
                    ...consumers,
                    "import-session.declarations.ts",
                    "import-session.extraction.ts",
                  ]
                : consumers,
            ).toContain(location);
            expect(ts.isImportDeclaration(node.parent)).toBe(true);
            if (ts.isImportDeclaration(node.parent)) {
              const clause = node.parent.importClause;
              const bindings = clause?.namedBindings;
              expect(clause?.name).toBeUndefined();
              expect(bindings && ts.isNamedImports(bindings)).toBe(true);
              if (bindings && ts.isNamedImports(bindings)) {
                for (const item of bindings.elements) {
                  expect(item.propertyName).toBeUndefined();
                  const names =
                    clause?.isTypeOnly || item.isTypeOnly
                      ? [...exports.runtime, ...exports.types]
                      : exports.runtime;
                  expect(names).toContain(item.name.text);
                }
              }
            }
          }
        }
        if (ts.isCallExpression(node)) {
          const name = ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : "";
          if (Object.prototype.hasOwnProperty.call(callSites, name)) {
            expect(callSites[name]).toContain(location);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  });

  it("registers exactly the dedicated documentary and financial routes", () => {
    const controller = source("import-session.controller.ts");
    const routes = [
      ...controller.matchAll(
        /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(([^)]*)\)/g,
      ),
    ]
      .map((match) => `${match[1]} ${match[2]}`)
      .sort();
    expect(routes).toEqual(
      [
        "Get ",
        'Get ":id"',
        'Get ":id/result"',
        'Get ":id/observations"',
        'Get ":id/candidates"',
        'Get ":id/current-lot"',
        "Post ",
        'Post ":id/cancel"',
        'Post ":id/declarations"',
        'Post ":id/resolutions"',
        'Post ":id/defer"',
        'Post ":id/reactivate"',
        'Post ":id/current-lot/prepare"',
        'Post ":id/interpretations"',
        'Post ":id/confirmation-challenge"',
        'Post ":id/confirm"',
        'Post ":id/execute"',
      ].sort(),
    );
    expect(controller).toMatch(/@Controller\("import-sessions"\)/);
  });

  it("the complete X3 attachment controller adds exactly four routes", () => {
    const paths = ownWith(/@Controller\b/);
    expect(paths).toHaveLength(withAttachments ? 2 : 1);
    if (!withAttachments) return;
    const controller = source("vault/import-attachment.controller.ts");
    expect(controller).toMatch(/@Controller\("import-sessions"\)/);
    expect(controller).toMatch(/@UseGuards\(ImportAuthGuard\)/);
    expect(controller).toMatch(/@UseFilters\(ImportSessionExceptionFilter\)/);
    expect(controller).not.toMatch(/@Public\b|SkipAuth|@Optional\(/);
    const routes = [
      ...controller.matchAll(
        /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(([^)]*)\)/g,
      ),
    ]
      .map((match) => `${match[1]} ${match[2]}`)
      .sort();
    expect(routes).toEqual([
      'Get ":id/attachments/:attachmentId/content"',
      'Post ":id/attachments"',
      'Post ":id/attachments/:attachmentId/analyze"',
      'Put ":id/attachments/:attachmentId/content"',
    ]);
    const blocks = controller.split(/\n(?=\s*@(?:Get|Post|Put)\()/);
    for (const block of blocks.filter((text) =>
      /^\s*@(?:Get|Post|Put)\(/.test(text),
    )) {
      expect(block).toMatch(/@ServiceOwnedProjectAccess\(\)/);
      if (/^\s*@Get\(/.test(block))
        expect(block).toMatch(
          /@UseGuards\(ImportSessionOperationThrottleGuard\)/,
        );
      else
        expect(block).toMatch(
          /@UseGuards\(ImportUiGuard(?:, ImportSessionOperationThrottleGuard)?\)/,
        );
    }
  });

  it("guards all mutations with UI admission, keeps reads unguarded and gates only create early", () => {
    const controller = source("import-session.controller.ts");
    // Class-level authentication (JWT claims -> branded context).
    expect(controller).toMatch(/@UseGuards\(ImportAuthGuard\)\s*export class/);
    const blocks = controller.split(/\n(?=\s*@(?:Get|Post|Patch)\()/);
    const postBlocks = blocks.filter((block) =>
      /^\s*@(?:Post|Patch)\(/.test(block),
    );
    expect(postBlocks).toHaveLength(11);
    for (const block of postBlocks)
      expect(block).toMatch(
        /@UseGuards\(ImportUiGuard(?:, ImportSessionOperationThrottleGuard)?\)/,
      );
    const readBlocks = blocks.filter((block) => /^\s*@Get\(/.test(block));
    expect(readBlocks).toHaveLength(6);
    for (const block of readBlocks) expect(block).not.toMatch(/@UseGuards/);
    // The complete intake gate is consulted BEFORE validation, grant issue or service call.
    const create =
      postBlocks.find((block) => /^\s*@Post\(\)/.test(block)) ?? "";
    const gate = create.indexOf("assertImportSessionIntakeAvailable(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(create.indexOf("parseCreateRequest"));
    expect(gate).toBeLessThan(create.indexOf("this.service.create"));
    expect(
      controller.match(/assertImportSessionIntakeAvailable\(/g),
    ).toHaveLength(1);
    // No public escape hatch and no cross-tenant/override seam.
    expect(controller).not.toMatch(/@Public\b|SkipAuth|@Optional\(/);
  });

  it("permits financial grant issuance only in the named controller", () => {
    const callers = productionFiles
      .filter((file) =>
        /\.issueFinancialAction\(/.test(readFileSync(file, "utf8")),
      )
      .map(rel);
    expect(callers).toEqual([
      "imports/import-session/import-session.controller.ts",
    ]);
  });

  it("only the worker extracts documents; the intake only validates and calls the native runner through RAW ownership", () => {
    const imports: Array<{ file: string; symbols: string[] }> = [];
    for (const path of productionFiles) {
      const file = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isStringLiteral(node) &&
          /(?:^|\/)statement-document$/.test(node.text)
        ) {
          expect(ts.isImportDeclaration(node.parent)).toBe(true);
          if (!ts.isImportDeclaration(node.parent))
            throw new Error("Dynamic documentary dependency");
          const clause = node.parent.importClause;
          expect(clause?.name).toBeUndefined();
          const bindings = clause?.namedBindings;
          if (!bindings || !ts.isNamedImports(bindings))
            throw new Error("Named documentary import required");
          imports.push({
            file: rel(path),
            symbols: bindings.elements
              .map((item) => (item.propertyName ?? item.name).text)
              .sort(),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(imports).toEqual([
      {
        file: "credit-card/parsers/statement-document.runner.ts",
        symbols: ["validateDocumentExtraction"],
      },
      {
        file: "credit-card/parsers/statement-document.worker.ts",
        symbols: ["extractCardStatementBinaryDocument"],
      },
      {
        file: "imports/import-session/import-session.extraction.ts",
        symbols: ["validateDocumentExtraction"],
      },
      {
        file: "imports/import-session/vault/import-upload.service.ts",
        symbols: [
          "DocumentExtractionError",
          "extractStrictCsvStatementDocument",
        ],
      },
    ]);
    const callers: string[] = [];
    for (const path of productionFiles) {
      const file = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(file) === "runCardStatementBinaryDocument"
        )
          callers.push(rel(path));
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(callers).toEqual([
      "imports/import-session/import-session.raw-executions.ts",
    ]);
    for (const path of ownFiles)
      expect(readFileSync(path, "utf8")).not.toMatch(
        /\bextractCardStatement(?:Binary)?Document\s*\(/,
      );
  });

  it("the service consults the intake gate first on create and keeps cancel on the operation switch", () => {
    const service = source("import-session.service.ts");
    const createBody = service.slice(
      service.indexOf("async create("),
      service.indexOf("async getSession("),
    );
    const cancelBody = service.slice(
      service.indexOf("async cancel("),
      service.indexOf("// -- internals"),
    );
    expect(
      createBody.indexOf("assertImportSessionIntakeAvailable"),
    ).toBeGreaterThan(-1);
    expect(
      createBody.indexOf("assertImportSessionIntakeAvailable"),
    ).toBeLessThan(createBody.indexOf("assertMintedImportContext"));
    expect(createBody).toMatch(/"CREATE_SESSION"/);
    expect(cancelBody).toMatch(/"CANCEL_SESSION"/);
    for (const body of [createBody, cancelBody]) {
      expect(body).toMatch(/this\.verifier\.verify\(/);
      expect(body).toMatch(/reauthorize\(tx, auth, now\)/);
    }
  });

  it("has no kill-switch override: env reads stay in UI origins, cursor and the prospective gate factory", () => {
    const envReaders = [
      "import-session-ui.guard.ts",
      "import-session.cursor.ts",
    ];
    if (withAttachments) envReaders.push("import-session.module.ts");
    expect(ownWith(/\bprocess\.env\b/)).toEqual(envReaders);
    const cursor = source("import-session.cursor.ts");
    expect(
      [...cursor.matchAll(/env\["([A-Z_]+)"\]/g)].map((m) => m[1]).sort(),
    ).toEqual(["JWT_SECRET", "NODE_ENV"]);
    expect(cursor).not.toMatch(/WRITES_ENABLED|writesEnabled/);
    const guard = source("import-session-ui.guard.ts");
    expect(
      [...guard.matchAll(/process\.env\["([A-Z_]+)"\]/g)]
        .map((m) => m[1])
        .sort(),
    ).toEqual(["CORS_ORIGIN", "NODE_ENV"]);
    const capability = source("import-session.capability.ts");
    expect(capability).toContain("IMPORT_SESSION_WRITES_ENABLED");
    expect(capability).not.toMatch(/process\.env|ConfigService/);
  });

  it("the recovery list is read-only: the list/cursor helpers hold no write statement and the route has no UI guard", () => {
    for (const name of ["import-session.list.ts", "import-session.cursor.ts"]) {
      expect(source(name)).not.toMatch(
        /\$executeRaw|\bUPDATE\s+\w+\s+SET|\bINSERT\s+INTO|\bDELETE\s+FROM|BEGIN\s+IMMEDIATE|\.(create|createMany|updateMany|upsert|deleteMany)\(/i,
      );
    }
    const controller = source("import-session.controller.ts");
    // The only decorator between @Get() and list() is the static project-access opt-out.
    expect(controller).toMatch(
      /@Get\(\)\s+@ServiceOwnedProjectAccess\(\)\s+list\(/,
    );
    expect(controller).not.toMatch(/@Get\(\)\s+@UseGuards/);
    expect(controller).not.toMatch(
      /@Get\(\)\s+@ServiceOwnedProjectAccess\(\)\s+@UseGuards/,
    );
  });

  it("uses no network, filesystem, process or configuration seam and never constructs its own database client", () => {
    const violations: string[] = [];
    for (const file of ownFiles) {
      // A type-only import is erased at compile time: it is not a runtime seam.
      const text = readFileSync(file, "utf8").replace(
        /^import type [^;]*;$/gm,
        "",
      );
      // Inactive collectors only; the boot orchestrator gets no filesystem exception.
      const isDurability =
        rel(file) === "imports/import-session/vault/vault-durability.ts";
      const isProbe =
        rel(file) === "imports/import-session/vault/vault-probe.ts" ||
        isDurability;
      const isStorage =
        rel(file) === "imports/import-session/vault/vault-storage.ts";
      for (const forbidden of [
        /\bConfigService\b/,
        /\bnew (PrismaService|PrismaClient)\b/,
        /\bfetch\(/,
        isProbe || isStorage
          ? /from "node:(http|https|net|child_process)"/
          : /from "node:(http|https|net|fs|child_process)"/,
        /\$queryRawUnsafe|\$executeRawUnsafe/,
      ])
        if (forbidden.test(text))
          violations.push(`${rel(file)} matches ${forbidden}`);
      if (isProbe) {
        expect(
          isDurability
            ? [["node:fs"]]
            : [["node:fs"], ["node:fs", "node:path"]],
        ).toContainEqual(
          [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]),
        );
        expect(text).not.toMatch(/\brequire\(|\bimport\(/);
      }
    }
    expect(violations).toEqual([]);
  });

  it("is imported by production code only through the application module registration", () => {
    const leaks = productionFiles
      .filter((file) => !file.startsWith(here))
      .filter((file) => !rel(file).startsWith("prisma/"))
      .filter((file) =>
        /import-session|CARD_PURCHASE_BATCH_PORT|\.import(Session|Artifact|SessionArtifact|Observation)\b|ImportSessionCapabilityDisabledError|UiImportPersistenceGrant/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(rel);
    // No agent/tool, financial service or other module reaches into the intake.
    // main.ts registers the B2a upload framing middleware (slice 1a) and nothing else.
    expect(leaks).toEqual([
      "agent/agent.controller.ts",
      "agent/agent.module.ts",
      "agent/agent.service.ts",
      "agent/tools/agent-tools.service.ts",
      "app.module.ts",
      "main.ts",
    ]);
    const mainTs = readFileSync(join(srcRoot, "main.ts"), "utf8");
    expect(
      mainTs.match(/registerImportUploadFraming|import-session|ImportSession/g),
    ).toEqual([
      "registerImportUploadFraming", // import
      "import-session", // its path
      "registerImportUploadFraming", // the single call
    ]);
    const appModule = readFileSync(join(srcRoot, "app.module.ts"), "utf8");
    expect(appModule.match(/ImportSessionModule/g)?.length).toBe(2); // import + registration
    const shutdownCalls = [
      ...mainTs.matchAll(/\.enableShutdownHooks\(([^)]*)\)/g),
    ].map((match) => match[1].replace(/\s/g, ""));
    expect(shutdownCalls).toEqual(
      withAttachments ? ['["SIGTERM","SIGINT"]'] : [],
    );
  });

  it("no production file depends on test helpers", () => {
    const dependents = productionFiles
      .filter((file) => /test-utils/.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(dependents).toEqual([]);
  });

  it("only the intake persists to the four models (soft-delete allowlist aside)", () => {
    const service = readFileSync(
      join(srcRoot, "prisma/prisma.service.ts"),
      "utf8",
    );
    for (const model of [
      "ImportSession",
      "ImportArtifact",
      "ImportSessionArtifact",
      "ImportObservation",
    ])
      expect(service).toContain(`'${model}',`);
    const others = productionFiles
      .filter((file) => !file.startsWith(here))
      .filter((file) => !file.endsWith("prisma/prisma.service.ts"))
      .filter((file) =>
        /\b(importSession|importArtifact|importSessionArtifact|importObservation)\b/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(rel);
    expect(others).toEqual([]);
    // Only the literal future adapter may write finance; absence is not execution evidence.
    const intake = ownFiles
      .filter(
        (file) => relative(here, file) !== "card-purchase-batch.adapter.ts",
      )
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(intake).not.toMatch(
      /\.(expense|cashFlowEntry|invoice|bankAccount|creditCard|cashFlow)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
    );
    const allowedWrites: Record<string, readonly string[]> = {
      "import-session.extraction.service.ts": [
        "importSession.updateMany",
        "importArtifact.updateMany",
        "importObservation.create",
      ],
      "vault/vault-purger.ts": [
        "importArtifact.updateMany",
        "importSessionArtifact.updateMany",
      ],
      "vault/import-upload.service.ts": [
        "importSession.updateMany",
        "importSessionArtifact.create",
        "importSessionArtifact.updateMany",
        "importArtifact.create",
        "importArtifact.updateMany",
      ],
      "vault/vault-reaper.ts": [
        "importArtifact.updateMany",
        "importSession.updateMany",
        "importSessionArtifact.updateMany",
      ],
      "import-session-interpretation.service.ts": ["importSession.updateMany"],
    };
    const forbiddenWrites = (file: string, text: string): string[] =>
      [
        ...text.matchAll(
          /\.(importSession|importArtifact|importSessionArtifact|importObservation)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g,
        ),
      ]
        .filter(
          ([, model, verb]) =>
            !allowedWrites[file]?.includes(`${model}.${verb}`),
        )
        .map(([call]) => call);
    expect(
      forbiddenWrites(
        "vault/vault-purger.ts",
        "tx.importArtifact.updateMany({}); tx.importSessionArtifact.updateMany({});",
      ),
    ).toEqual([]);
    expect(
      forbiddenWrites(
        "vault/import-upload.service.ts",
        "tx.importSession.updateMany({}); tx.importSessionArtifact.create({}); tx.importSessionArtifact.updateMany({}); tx.importArtifact.create({}); tx.importArtifact.updateMany({});",
      ),
    ).toEqual([]);
    expect(
      forbiddenWrites(
        "vault/vault-reaper.ts",
        "tx.importSession.updateMany({}); tx.importSessionArtifact.updateMany({});",
      ),
    ).toEqual([]);
    for (const file of [
      "vault/import-upload.service.ts",
      "vault/vault-reaper.ts",
      "vault/import-content.service.ts",
      "vault/import-attachment.controller.ts",
      "vault/vault-state.ts",
    ]) {
      expect(
        forbiddenWrites(file, "tx.importObservation.updateMany({});"),
      ).toEqual([".importObservation.updateMany"]);
      expect(forbiddenWrites(file, "tx.importSession.create({});")).toEqual([
        ".importSession.create",
      ]);
      for (const verb of [
        "createMany",
        "update",
        "upsert",
        "delete",
        "deleteMany",
      ])
        expect(
          forbiddenWrites(file, `tx.importSessionArtifact.${verb}({});`),
        ).toEqual([`.importSessionArtifact.${verb}`]);
    }
    for (const file of [
      "vault/vault-reaper.ts",
      "vault/import-content.service.ts",
      "vault/import-attachment.controller.ts",
      "vault/vault-state.ts",
      "vault/other/import-upload.service.ts",
    ])
      expect(forbiddenWrites(file, "tx.importArtifact.create({});")).toEqual([
        ".importArtifact.create",
      ]);
    for (const model of ["importArtifact", "importSessionArtifact"]) {
      for (const file of [
        "vault/vault-storage.ts",
        "vault/other/vault-purger.ts",
        "other.ts",
      ])
        expect(forbiddenWrites(file, `tx.${model}.updateMany({});`)).toEqual([
          `.${model}.updateMany`,
        ]);
      for (const verb of [
        "create",
        "createMany",
        "update",
        "upsert",
        "delete",
        "deleteMany",
      ])
        expect(
          forbiddenWrites("vault/vault-purger.ts", `tx.${model}.${verb}({});`),
        ).toEqual([`.${model}.${verb}`]);
    }
    for (const model of ["importSession", "importObservation"])
      for (const verb of [
        "create",
        "createMany",
        "update",
        "updateMany",
        "upsert",
        "delete",
        "deleteMany",
      ])
        expect(
          forbiddenWrites("vault/vault-purger.ts", `tx.${model}.${verb}({});`),
        ).toEqual([`.${model}.${verb}`]);
    const outsidePublisher = ownFiles
      .filter(
        (file) =>
          ![
            "import-session.service.ts",
            "import-session-workflow.service.ts",
          ].includes(relative(here, file)),
      )
      .flatMap((file) =>
        forbiddenWrites(relative(here, file), readFileSync(file, "utf8")),
      );
    expect(outsidePublisher).toEqual([]);
  });
});
