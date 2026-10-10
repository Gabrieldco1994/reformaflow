"use strict";
const { setTimeout: delay } = require("node:timers/promises");
const READINESS_BUDGET_MS = 60000;
const REQUEST_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 250;

/** Transport readiness only. Never retries inference, invalid JSON/model declarations or auth. */
async function waitForOllamaTags(url, options = {}) {
  const budgetMs = options.budgetMs ?? READINESS_BUDGET_MS;
  const requestMs = options.requestMs ?? REQUEST_TIMEOUT_MS;
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
  const fetchTags = options.fetch ?? fetch;
  for (const value of [budgetMs, requestMs, pollMs]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("BAD_READINESS_BUDGET");
  }
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    let response;
    const timeout = Math.max(
      1,
      Math.ceil(Math.min(requestMs, deadline - performance.now())),
    );
    const signal = AbortSignal.timeout(timeout);
    try {
      response = await fetchTags(url, { signal });
    } catch (error) {
      if (
        !signal.aborted &&
        !(error instanceof TypeError && error.message === "fetch failed")
      )
        throw error;
    }
    if (response) {
      if (response.ok) {
        // JSON/body transport remains bounded by the same request signal.
        let tags;
        try {
          tags = await response.json();
        } catch (error) {
          if (!signal.aborted) throw error;
        }
        if (tags !== undefined) {
          if (
            !tags ||
            !Array.isArray(tags.models) ||
            !tags.models.every(
              (m) =>
                m &&
                typeof m === "object" &&
                (typeof m.name === "string" || typeof m.model === "string"),
            )
          ) {
            throw new Error("INVALID_OLLAMA_TAGS");
          }
          return tags;
        }
      } else {
        await response.body?.cancel();
        if (response.status !== 503)
          throw new Error(`OLLAMA_TAGS_HTTP_${response.status}`);
      }
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(pollMs, remaining));
  }
  throw new Error("OLLAMA_READINESS_TIMEOUT");
}
module.exports = { waitForOllamaTags };
