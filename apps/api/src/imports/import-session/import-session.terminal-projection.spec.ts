import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ImportSessionController } from "./import-session.controller";
import type { AuthenticatedImportContext } from "./import-session.contract";
import {
  IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY,
  IMPORT_SESSION_TERMINAL_OUTCOMES_VERSION,
  ImportSessionService,
  parseSessionProjectionQuery,
} from "./import-session.service";

const terminalOutcomeProjection = {
  [IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY]:
    IMPORT_SESSION_TERMINAL_OUTCOMES_VERSION,
} as const;

describe("GET import-session terminal outcome projection", () => {
  it("keeps the legacy projection by default and opts in only to v1", () => {
    expect(parseSessionProjectionQuery({})).toEqual({
      includeTerminalOutcomes: false,
    });
    expect(parseSessionProjectionQuery(terminalOutcomeProjection)).toEqual({
      includeTerminalOutcomes: true,
    });
  });

  describe("GET /import-sessions/:id/terminal-outcomes-v1 strict boundary", () => {
    const strictPath = ":id/terminal-outcomes-v1";
    const controllerPrototype = ImportSessionController.prototype;
    const methods = Object.getOwnPropertyNames(controllerPrototype).filter(
      (name) => name !== "constructor",
    );
    const route = methods.find(
      (name) =>
        Reflect.getMetadata(
          PATH_METADATA,
          controllerPrototype[name as keyof ImportSessionController],
        ) === strictPath,
    );

    it("declares the literal GET boundary before the generic :id route", () => {
      const genericIndex = methods.indexOf("getSession");
      const strictIndex = route === undefined ? -1 : methods.indexOf(route);
      const handler =
        route === undefined
          ? undefined
          : controllerPrototype[route as keyof ImportSessionController];

      expect({
        route,
        path:
          handler === undefined
            ? null
            : Reflect.getMetadata(PATH_METADATA, handler),
        method:
          handler === undefined
            ? null
            : Reflect.getMetadata(METHOD_METADATA, handler),
        beforeGeneric: strictIndex >= 0 && strictIndex < genericIndex,
      }).toEqual({
        route: expect.any(String),
        path: strictPath,
        method: RequestMethod.GET,
        beforeGeneric: true,
      });
    });

    it("returns only the exact v1 envelope and performs no write", async () => {
      const sessionId = randomUUID();
      const auth = {} as AuthenticatedImportContext;
      const envelope = {
        version: 1,
        sessionId,
        revision: 7,
        outcomes: [
          {
            attachmentId: randomUUID(),
            code: "DOCUMENT_UNREADABLE",
          },
        ],
      };
      const calls: string[] = [];
      const writes: string[] = [];
      const service = new Proxy(
        {},
        {
          get: (_target, property) => {
            if (typeof property !== "string") return undefined;
            return jest.fn(async () => {
              calls.push(property);
              if (
                /create|update|delete|cancel|confirm|execute|apply|write/i.test(
                  property,
                )
              )
                writes.push(property);
              return envelope;
            });
          },
        },
      );
      const controller = new ImportSessionController(
        service as ImportSessionService,
        {} as never,
        {} as never,
        {} as never,
      );
      const handler =
        route === undefined
          ? undefined
          : (controller[route as keyof ImportSessionController] as unknown as (
              auth: AuthenticatedImportContext,
              id: string,
            ) => Promise<unknown>);
      const observation =
        handler === undefined
          ? { kind: "ROUTE_ABSENT" as const }
          : {
              kind: "RETURNED" as const,
              value: await handler.call(controller, auth, sessionId),
            };

      expect({
        observation,
        calls,
        writes,
        responseKeys:
          observation.kind === "RETURNED"
            ? Object.keys(observation.value as object)
            : [],
        outcomeKeys:
          observation.kind === "RETURNED"
            ? Object.keys(
                (
                  observation.value as {
                    outcomes: Array<Record<string, unknown>>;
                  }
                ).outcomes[0]!,
              )
            : [],
      }).toEqual({
        observation: { kind: "RETURNED", value: envelope },
        calls: [expect.any(String)],
        writes: [],
        responseKeys: ["version", "sessionId", "revision", "outcomes"],
        outcomeKeys: ["attachmentId", "code"],
      });
    });
  });

  it.each([
    { [IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY]: "" },
    { [IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY]: ["v1"] },
    { [IMPORT_SESSION_TERMINAL_OUTCOMES_QUERY]: "v2" },
    { unrelated: IMPORT_SESSION_TERMINAL_OUTCOMES_VERSION },
    {
      ...terminalOutcomeProjection,
      unrelated: IMPORT_SESSION_TERMINAL_OUTCOMES_VERSION,
    },
  ])("rejects an ambiguous or unsupported projection query", (query) => {
    expect(() => parseSessionProjectionQuery(query)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("passes the exact query through the authenticated GET boundary", async () => {
    const view = { id: randomUUID() };
    const service = {
      getSession: jest.fn().mockResolvedValue(view),
    };
    const controller = new ImportSessionController(
      service as unknown as ImportSessionService,
      {} as never,
      {} as never,
      {} as never,
    );
    const auth = {} as AuthenticatedImportContext;
    const sessionId = randomUUID();

    await expect(
      controller.getSession(auth, sessionId, terminalOutcomeProjection),
    ).resolves.toBe(view);
    expect(service.getSession).toHaveBeenCalledWith(
      auth,
      sessionId,
      terminalOutcomeProjection,
    );
  });
});
