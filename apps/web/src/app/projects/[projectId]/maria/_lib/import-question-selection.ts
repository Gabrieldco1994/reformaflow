import type { ImportSessionQuestionV1 } from "@reformaflow/domain";

export const questionIntersectsSelectedLines = (
  question: Pick<ImportSessionQuestionV1, "lineIds">,
  selectedLineIds: readonly string[],
) => question.lineIds.some((id) => selectedLineIds.includes(id));
