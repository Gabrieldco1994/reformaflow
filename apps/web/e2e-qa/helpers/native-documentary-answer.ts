import fs from "node:fs/promises";
import {
  expect,
  type Page,
  type Response,
  type TestInfo,
} from "@playwright/test";
import {
  normalizeImportDeclaration,
  type ImportObservationQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";

/** Native FE 1cd6b1dc: match the saved preview, NOT an LLM ANSWER turn.
 * Domain-only normalization; no transitive production view/service imports.
 */
export function nativeDocumentaryContract(
  sessionId: string,
  question: ImportObservationQuestionV1,
  current: ImportSessionViewV1,
  text: string,
) {
  const count = current.declaredFacts.find(
    (fact) =>
      fact.field === "installmentCount" &&
      fact.status === "CURRENT" &&
      fact.lineId === question.lineIds[0] &&
      fact.observationId === question.subject.observationId,
  );
  const effectiveInstallmentCount =
    count?.field === "installmentCount" ? count.value : null;
  const input = { kind: "VALUE" as const, text };
  const normalized = normalizeImportDeclaration(
    question.field === "amountCents"
      ? {
          field: question.field,
          meaningContext: question.subject.meaningContext,
          effectiveInstallmentCount,
        }
      : {
          field: question.field,
          meaningContext: null,
          effectiveInstallmentCount,
        },
    input,
  );
  expect(
    normalized.kind,
    "Fixture literal must produce a valid native preview",
  ).toBe("VALID");
  if (normalized.kind !== "VALID") throw new Error("Invalid fixture preview");
  const expected = {
    version: 1,
    expectedRevision: current.revision,
    questionId: question.id,
    input,
    answer: normalized.answer,
  };
  const matches = (response: Response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname ===
      `/import-sessions/${sessionId}/documentary-answer` &&
    response.request().postDataJSON()?.questionId === question.id;
  const assertSaved = async (response: Response) => {
    const request = response.request().postDataJSON();
    expect(Object.keys(request).sort()).toEqual(
      [
        "version",
        "answerRequestId",
        "expectedRevision",
        "questionId",
        "input",
        "answer",
      ].sort(),
    );
    expect(request).toEqual({
      ...expected,
      answerRequestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(
      response.ok(),
      `Native documentary answer HTTP ${response.status()}`,
    ).toBe(true);
    const fresh: ImportSessionViewV1 = await response.json();
    expect(fresh.id).toBe(sessionId);
    expect(fresh.revision).toBe(current.revision + 1);
    expect(
      fresh.declaredFacts.filter(
        (fact) =>
          fact.questionId === question.id &&
          fact.lineId === question.lineIds[0] &&
          fact.observationId === question.subject.observationId,
      ),
    ).toEqual([
      expect.objectContaining({
        field: normalized.answer.field,
        value: normalized.answer.value,
        meaningContext: normalized.answer.meaningContext,
        status: "CURRENT",
      }),
    ]);
  };
  return { matches, assertSaved };
}

export async function captureNativeDocumentaryAnswer(
  page: Page,
  info: TestInfo,
  name: string,
  contract: ReturnType<typeof nativeDocumentaryContract>,
  submit: () => Promise<void>,
) {
  const artifact = info.outputPath(`${name}-native-response.json`);
  const started = Date.now();
  const pending = page.waitForResponse(contract.matches, { timeout: 120_000 });
  try {
    const [response] = await Promise.all([pending, submit()]);
    // Only synthetic documentary payloads; never auth headers/cookies/signup data.
    await fs.writeFile(
      artifact,
      JSON.stringify(
        {
          transportBudgetMs: 120_000,
          elapsedMs: Date.now() - started,
          path: new URL(response.url()).pathname,
          status: response.status(),
          request: response.request().postDataJSON(),
          response: await response.text(),
        },
        null,
        2,
      ),
    );
    await contract.assertSaved(response);
  } catch (error) {
    await fs.writeFile(
      `${artifact}.failure.json`,
      JSON.stringify({
        transportBudgetMs: 120_000,
        elapsedMs: Date.now() - started,
        failure: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}
