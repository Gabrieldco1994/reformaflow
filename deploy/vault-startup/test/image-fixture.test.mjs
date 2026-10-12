import assert from "node:assert/strict";
import test from "node:test";
import { lazyPublishedOrigin } from "./image-fixture.mjs";

test("failed startup paths do not require Docker to retain a published port", () => {
  const calls = [];
  const publishedOrigin = lazyPublishedOrigin("failed-container", (...args) => {
    calls.push(args);
    return "127.0.0.1:49152";
  });

  assert.deepEqual(calls, []);
  assert.equal(publishedOrigin(), "http://127.0.0.1:49152");
  assert.equal(publishedOrigin(), "http://127.0.0.1:49152");
  assert.deepEqual(calls, [["port", "failed-container", "3001/tcp"]]);
});

test("a missing Docker publication still fails when an HTTP test requests it", () => {
  const publishedOrigin = lazyPublishedOrigin("running-container", () => "");

  assert.throws(
    () => publishedOrigin(),
    /The input did not match the regular expression/,
  );
});
