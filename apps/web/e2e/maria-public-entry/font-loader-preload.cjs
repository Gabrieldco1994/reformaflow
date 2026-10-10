const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { isAbsolute, resolve } = require("node:path");

if (process.env.TZ !== "UTC")
  throw new Error("Font loader preflight requires TZ=UTC");
for (const name of ["DATABASE_URL", "TEST_DATABASE_URL"])
  if (process.env[name])
    throw new Error(`Font loader preflight forbids ${name}`);

const responses = resolve(__dirname, "font-loader-responses.cjs");
const requested = process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES ?? responses;
if (!isAbsolute(requested) || resolve(requested) !== responses)
  throw new Error("Font loader responses must use the accepted absolute path");
process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = responses;

const blocked = (name) => {
  throw new Error(`Font loader preflight blocked network via ${name}`);
};
net.connect = (..._args) => blocked("net.connect");
net.createConnection = (..._args) => blocked("net.createConnection");
http.get = (..._args) => blocked("http.get");
http.request = (..._args) => blocked("http.request");
https.get = (..._args) => blocked("https.get");
https.request = (..._args) => blocked("https.request");
globalThis.fetch = (..._args) => blocked("fetch");

Object.defineProperty(globalThis, "__PUBLIC_ENTRY_FONT_PREFLIGHT__", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({ responses }),
});
