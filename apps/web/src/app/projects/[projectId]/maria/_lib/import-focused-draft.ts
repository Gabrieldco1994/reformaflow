import {
  ExpenseType,
  parseInstallmentDateOnlyUtc,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
  type ImportSessionFocusedDraftAnswerV1,
} from "@reformaflow/domain";

export function isFocusedDraftQuestion(
  question: ImportSessionQuestionV1,
): boolean {
  return (
    !("subject" in question) &&
    (question.field === "firstDueDate" || question.field === "tipoDespesa")
  );
}

export function validFocusedDraftAnswer(
  answer: ImportSessionFocusedDraftAnswerV1,
) {
  if (answer.value === null) return true;
  if (answer.field === "tipoDespesa")
    return Object.values(ExpenseType).some((type) => type === answer.value);
  return (
    answer.field === "firstDueDate" &&
    /^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(answer.value) &&
    parseInstallmentDateOnlyUtc(answer.value) !== null
  );
}

/** Only the focused field may change; this read never authorizes preparation or finance. */
export function verifiedFocusedDraftAnswer(
  previous: ImportSessionViewV1,
  fresh: ImportSessionViewV1,
  question: ImportSessionQuestionV1,
  answer: ImportSessionFocusedDraftAnswerV1,
): boolean {
  if (
    fresh.id !== previous.id ||
    fresh.ownerProjectId !== previous.ownerProjectId ||
    fresh.cardId !== previous.cardId ||
    !isFocusedDraftQuestion(question) ||
    question.field !== answer.field ||
    !question.lineIds.length ||
    fresh.lines.length !== previous.lines.length ||
    fresh.confirmation !== null ||
    fresh.receipt !== null ||
    (fresh.state !== "DRAFT" && fresh.state !== previous.state) ||
    JSON.stringify(fresh.selectedLineIds) !==
      JSON.stringify(previous.selectedLineIds) ||
    JSON.stringify(fresh.declaredFacts) !==
      JSON.stringify(previous.declaredFacts)
  )
    return false;
  const focused = new Set(question.lineIds);
  if (
    !question.lineIds.every((id) =>
      previous.lines.some((line) => line.id === id),
    )
  )
    return false;
  for (const before of previous.lines) {
    const after = fresh.lines.find((line) => line.id === before.id);
    if (!after) return false;
    if (focused.has(before.id)) {
      if (
        after[answer.field] !== answer.value ||
        JSON.stringify({ ...before, [answer.field]: answer.value }) !==
          JSON.stringify(after)
      )
        return false;
    } else if (JSON.stringify(before) !== JSON.stringify(after)) return false;
  }
  const changed = previous.lines.some(
    (line) => focused.has(line.id) && line[answer.field] !== answer.value,
  );
  return changed
    ? fresh.revision === previous.revision + 1 && fresh.proposal === null
    : fresh.revision === previous.revision &&
        fresh.expiresAt === previous.expiresAt &&
        JSON.stringify(fresh.proposal) === JSON.stringify(previous.proposal);
}
