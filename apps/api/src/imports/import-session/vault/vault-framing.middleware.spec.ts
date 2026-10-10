import {
  Body,
  Controller,
  Delete,
  Get,
  type INestApplication,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { registerImportUploadFraming } from "./vault-framing";

/**
 * B2a slice 1a: the shared framing middleware in a REAL Nest app (default body parsers, mounted
 * in the `main.ts` order) with a test-only stub controller: no database, no vault, no authority.
 * The stub stands where the real controllers will stand; it only reports what reached it.
 */
@Controller("import-sessions")
class StubController {
  @Put(":id/attachments/:attachmentId/content")
  async put(@Req() req: http.IncomingMessage) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of req) {
      hash.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }
    return { reached: "put-content", bytes, sha256: hash.digest("hex") };
  }
  @Put(":id/attachments/:attachmentId/content/extra")
  putExtra(@Body() body: unknown) {
    return { reached: "put-extra", body };
  }
  @Get(":id/attachments/:attachmentId/content")
  get() {
    return { reached: "get-content" };
  }
  @Delete(":id/attachments/:attachmentId/content")
  del() {
    return { reached: "delete-content" };
  }
  @Post(":id/attachments")
  reserve(@Body() body: unknown) {
    return { reached: "reserve", body };
  }
}

const ALLOWED = "https://app.example";
const PATH = "/import-sessions/s1/attachments/a1/content";
const REFUSAL_KEYS = [
  "code",
  "currentRevision",
  "reason",
  "retryable",
  "sessionId",
];

let app: INestApplication;
let wrongOrder: INestApplication;
let port: number;
let wrongPort: number;

async function build(order: "main" | "helper-first") {
  const moduleRef = await Test.createTestingModule({
    controllers: [StubController],
  }).compile();
  const nest = moduleRef.createNestApplication();
  const cors = () => nest.enableCors({ origin: [ALLOWED], credentials: true });
  if (order === "main") {
    cors();
    registerImportUploadFraming(nest);
  } else {
    registerImportUploadFraming(nest);
    cors();
  }
  await nest.listen(0, "127.0.0.1");
  return nest;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  text: string;
}
function call(
  targetPort: number,
  method: string,
  path: string,
  headers: Record<string, string | number>,
  body?: Buffer | string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method,
        path,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        const done = () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json,
            text,
          });
        };
        res.on("end", done);
        res.on("close", done);
      },
    );
    // A server that never answers fails THIS call instead of hanging the test and the hooks.
    req.setTimeout(3000, () =>
      req.destroy(new Error("no response within 3000 ms")),
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const octet = (length: number | string): Record<string, string | number> => ({
  "content-type": "application/octet-stream",
  "content-length": length,
});
const refusal = (code: string, retryable = false) => ({
  code,
  retryable,
  sessionId: null,
  currentRevision: null,
  reason: null,
});

describe("B2a slice 1a — registerImportUploadFraming in a real Nest app", () => {
  beforeAll(async () => {
    app = await build("main");
    port = (app.getHttpServer().address() as AddressInfo).port;
    wrongOrder = await build("helper-first");
    wrongPort = (wrongOrder.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    // A request left waiting for a body (e.g. under a mutant that lets a refusal through) must not
    // keep the hook waiting on a keep-alive connection.
    for (const nest of [app, wrongOrder]) {
      (nest?.getHttpServer() as http.Server | undefined)?.closeAllConnections();
      await nest?.close();
    }
  });

  describe("what is let through", () => {
    it.each([1000, 1024 * 1024, 10 * 1024 * 1024])(
      "an octet-stream PUT of %i bytes reaches the handler byte for byte (the parser did not consume it)",
      async (size) => {
        const payload = Buffer.alloc(size, 0x41);
        const reply = await call(port, "PUT", PATH, octet(size), payload);
        expect(reply.status).toBe(200);
        expect(reply.json).toEqual({
          reached: "put-content",
          bytes: size,
          sha256: createHash("sha256").update(payload).digest("hex"),
        });
      },
    );

    it("Content-Encoding: identity is not a framing error", async () => {
      const reply = await call(
        port,
        "PUT",
        PATH,
        { ...octet(3), "content-encoding": "identity" },
        "abc",
      );
      expect([reply.status, reply.json.reached]).toEqual([200, "put-content"]);
    });
  });

  describe("what is refused, with the closed map and the exact wire", () => {
    const hostile: Array<
      [string, Record<string, string | number>, number, string]
    > = [
      ["no Content-Type", { "content-length": 2 }, 422, "UNSUPPORTED_DOCUMENT"],
      [
        "JSON",
        { "content-type": "application/json", "content-length": 2 },
        422,
        "UNSUPPORTED_DOCUMENT",
      ],
      [
        "multipart",
        {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": 2,
        },
        422,
        "UNSUPPORTED_DOCUMENT",
      ],
      [
        "octet-stream with a parameter",
        {
          "content-type": "application/octet-stream; charset=x",
          "content-length": 2,
        },
        422,
        "UNSUPPORTED_DOCUMENT",
      ],
      [
        "Transfer-Encoding: chunked",
        {
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
        },
        400,
        "INVALID_INPUT",
      ],
      [
        "Content-Encoding: gzip",
        { ...octet(2), "content-encoding": "gzip" },
        400,
        "INVALID_INPUT",
      ],
      ["Content-Length: 0", octet(0), 400, "INVALID_INPUT"],
      [
        "Content-Length over 10 MiB",
        octet(10 * 1024 * 1024 + 1),
        400,
        "INVALID_INPUT",
      ],
      [
        "Content-Length absent",
        { "content-type": "application/octet-stream" },
        400,
        "INVALID_INPUT",
      ],
    ];
    it.each(hostile)("%s", async (_name, headers, status, code) => {
      const body = "content-length" in headers ? "{}" : undefined;
      const reply = await call(port, "PUT", PATH, headers, body);
      expect(reply.status).toBe(status);
      expect(reply.json).toEqual(refusal(code));
      expect(Object.keys(reply.json).sort()).toEqual(REFUSAL_KEYS);
      expect(String(reply.headers.connection).toLowerCase()).toBe("close");
    });

    it("MALFORMED JSON is the application's 422, not the parser's 400 (the parser never ran)", async () => {
      const reply = await call(
        port,
        "PUT",
        PATH,
        { "content-type": "application/json", "content-length": 3 },
        "{x}",
      );
      expect([reply.status, reply.json]).toEqual([
        422,
        refusal("UNSUPPORTED_DOCUMENT"),
      ]);
    });

    it.each([
      ["a trailing slash", `${PATH}/`],
      ["upper-case segments", PATH.toUpperCase()],
      ["a query string", `${PATH}?x=1`],
      [
        "an encoded slash inside the id",
        "/import-sessions/s%2F1/attachments/a1/content",
      ],
    ])("the same refusal holds with %s", async (_name, path) => {
      const reply = await call(
        port,
        "PUT",
        path,
        { "content-type": "application/json", "content-length": 2 },
        "{}",
      );
      expect([reply.status, reply.json]).toEqual([
        422,
        refusal("UNSUPPORTED_DOCUMENT"),
      ]);
    });

    it("the refusal reads no store and asks no authority: it answers for ids that exist nowhere, without any Authorization", async () => {
      const reply = await call(
        port,
        "PUT",
        "/import-sessions/does-not-exist/attachments/nor-this/content",
        { "content-type": "application/json", "content-length": 2 },
        "{}",
      );
      expect(reply.status).toBe(422);
    });
  });

  describe("what is left alone: scope is PUT on exactly the content route", () => {
    const hostileJson = {
      "content-type": "application/json",
      "content-length": 2,
    };
    it.each([
      ["GET", "get-content"],
      ["DELETE", "delete-content"],
    ])(
      "%s on the same path is untouched, hostile headers or not",
      async (method, reached) => {
        const reply = await call(port, method, PATH, hostileJson, "{}");
        expect([reply.status, reply.json.reached]).toEqual([200, reached]);
      },
    );

    it("a longer path (which is another route) is untouched: its JSON body is still parsed", async () => {
      const json = '{"a":1}';
      const reply = await call(
        port,
        "PUT",
        `${PATH}/extra`,
        { "content-type": "application/json", "content-length": json.length },
        json,
      );
      expect([reply.status, reply.json]).toEqual([
        200,
        { reached: "put-extra", body: { a: 1 } },
      ]);
    });

    it("the neighbouring JSON route keeps Nest's body parser", async () => {
      const reply = await call(
        port,
        "POST",
        "/import-sessions/s1/attachments",
        hostileJson,
        "{}",
      );
      expect([reply.status, reply.json]).toEqual([
        201,
        { reached: "reserve", body: {} },
      ]);
    });

    it("the CORS preflight of the content route is answered by CORS, not refused for lacking a body", async () => {
      const reply = await call(port, "OPTIONS", PATH, {
        origin: ALLOWED,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      });
      expect(reply.status).toBe(204);
      expect(reply.headers["access-control-allow-origin"]).toBe(ALLOWED);
    });
  });

  describe("CORS keeps working on a refusal (enableCors comes first)", () => {
    const bad = (origin: string) => ({
      origin,
      "content-type": "application/json",
      "content-length": 2,
    });
    it("an allowed origin reads the 422", async () => {
      const reply = await call(port, "PUT", PATH, bad(ALLOWED), "{}");
      expect(reply.status).toBe(422);
      expect(reply.headers["access-control-allow-origin"]).toBe(ALLOWED);
      expect(reply.headers["access-control-allow-credentials"]).toBe("true");
    });
    it("a disallowed origin gets the same refusal with no CORS grant", async () => {
      const reply = await call(
        port,
        "PUT",
        PATH,
        bad("https://evil.example"),
        "{}",
      );
      expect(reply.status).toBe(422);
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    });
    it("control: registering the helper BEFORE enableCors would lose the grant (the order is real)", async () => {
      const reply = await call(wrongPort, "PUT", PATH, bad(ALLOWED), "{}");
      expect(reply.status).toBe(422);
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });
  describe("the server ends a refused connection itself (persistent clients, body left incomplete)", () => {
    // Neither client asks for `Connection: close` and neither ends its side: only the server can
    // close. (The `call` helper uses agent:false, which makes the CLIENT send close, so it cannot
    // prove this.)
    interface Held {
      status: number;
      head: string;
      serverClosed: boolean;
    }
    const heldRaw = (
      requestHead: string,
      partialBody: string,
      windowMs: number,
    ): Promise<Held> =>
      new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        const received: Buffer[] = [];
        let serverClosed = false;
        const settle = () => {
          clearTimeout(timer);
          socket.destroy();
          const text = Buffer.concat(received).toString("utf8");
          resolve({
            status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0),
            head: text.split("\r\n\r\n", 1)[0]!,
            serverClosed,
          });
        };
        const timer = setTimeout(settle, windowMs);
        socket.on("data", (chunk) => received.push(chunk));
        socket.on("error", (error) => {
          if (received.length === 0) reject(error);
        });
        // 'close' before the window ends can only be the server: the client never ends or destroys.
        socket.on("close", () => {
          serverClosed = true;
          settle();
        });
        socket.write(requestHead + partialBody);
      });
    const head = (method: string, path: string, headers: string[]) =>
      [
        `${method} ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        ...headers,
        "",
        "",
      ].join("\r\n");

    it("raw persistent socket: a refused PUT is answered, then the server closes although the body is incomplete", async () => {
      const held = await heldRaw(
        head("PUT", PATH, [
          "Content-Type: application/json",
          "Content-Length: 5242880",
        ]),
        "{",
        2500,
      );
      expect(held.status).toBe(422);
      expect(held.head.toLowerCase()).toContain("connection: close");
      expect(held.serverClosed).toBe(true);
    });

    it("raw persistent socket: an invalid octet-stream framing (Transfer-Encoding) is closed by the server too", async () => {
      const held = await heldRaw(
        head("PUT", PATH, [
          "Content-Type: application/octet-stream",
          "Transfer-Encoding: chunked",
        ]),
        "5\r\nabcde\r\n",
        2500,
      );
      expect(held.status).toBe(400);
      expect(held.serverClosed).toBe(true);
    });

    it("control: a persistent GET on the same route stays open (the close is not a server-wide habit)", async () => {
      const held = await heldRaw(head("GET", PATH, []), "", 600);
      expect(held.status).toBe(200);
      expect(held.head.toLowerCase()).not.toContain("connection: close");
      expect(held.serverClosed).toBe(false);
    });

    it("control: a well-framed PUT whose body is still incomplete is not closed (it is waiting for the rest)", async () => {
      const held = await heldRaw(
        head("PUT", PATH, [
          "Content-Type: application/octet-stream",
          "Content-Length: 1000",
        ]),
        "abc",
        600,
      );
      expect(held.status).toBe(0);
      expect(held.serverClosed).toBe(false);
    });

    it("keep-alive http.Agent: the refused PUT is answered in full and its socket is closed by the server while the request body is left open", async () => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      let req: http.ClientRequest | undefined;
      try {
        // The capture deadline is armed BEFORE waiting for any response, so a server that stays
        // silent (or resets) ends the capture with status 0 instead of hanging the test and the hooks.
        const outcome = await new Promise<{
          status: number;
          connection: string | undefined;
          body: string;
          complete: boolean;
          socketClosed: boolean;
        }>((resolve) => {
          const seen = {
            status: 0,
            connection: undefined as string | undefined,
            body: "",
            complete: false,
            socketClosed: false,
          };
          const settle = () => {
            clearTimeout(deadline);
            resolve({ ...seen });
          };
          const deadline = setTimeout(settle, 2500);
          req = http.request(
            {
              host: "127.0.0.1",
              port,
              method: "PUT",
              path: PATH,
              agent,
              headers: {
                "content-type": "application/json",
                "content-length": 5242880,
              },
            },
            (res) => {
              seen.status = res.statusCode ?? 0;
              seen.connection = res.headers.connection;
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (seen.body += chunk));
              res.on("end", () => (seen.complete = true));
              // The client never ends the request nor destroys the socket; only the server can.
              const closed = () => {
                seen.socketClosed = true;
                setTimeout(settle, 25);
              };
              if (res.socket.destroyed) closed();
              else res.socket.once("close", closed);
            },
          );
          req.on("error", settle);
          req.write("{");
        });
        expect(outcome.status).toBe(422);
        expect(outcome.connection).toBe("close");
        expect(outcome.complete).toBe(true);
        expect(JSON.parse(outcome.body)).toEqual(
          refusal("UNSUPPORTED_DOCUMENT"),
        );
        expect(outcome.socketClosed).toBe(true);
      } finally {
        req?.destroy();
        agent.destroy();
      }
    });
  });
});
