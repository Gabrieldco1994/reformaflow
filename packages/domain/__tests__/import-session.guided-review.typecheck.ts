import type {
  ContinueAnsweringCommandV1,
  ImportSessionGuidedReviewV1,
  ImportSessionTargetInputV1,
} from "@reformaflow/domain";
import { LaborCategory } from "@reformaflow/domain";

const continueAnswering: ContinueAnsweringCommandV1 = {
  version: 1,
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: 30,
};
void continueAnswering;

const target: ImportSessionTargetInputV1 = {
  projectId: "reforma-a",
  roomId: null,
  amountCents: 10_001,
};

const focusBase = {
  questionId: "question-a",
  lineId: "line-a",
  prompt: "Criar esta compra?",
  purchaseOrdinal: 1,
  purchaseTotal: 2,
  questionOrdinal: 1,
  questionTotal: 3,
  context: {
    title: "Compra A",
    merchant: null,
    amountCents: 10_001,
    purchaseDate: "2026-10-01",
  },
} as const;

const flatDecision: ImportSessionGuidedReviewV1 = {
  progress: "ANSWERING",
  focus: {
    ...focusBase,
    control: "DECISION",
    options: [
      {
        label: "Criar nova compra",
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
    ],
  },
  actions: ["CONTINUE_ANSWERING"],
};

const sourceOnly: ImportSessionGuidedReviewV1 = {
  ...flatDecision,
  focus: {
    ...focusBase,
    control: "TARGETS",
    options: [
      {
        label: "Somente em Minhas finanças",
        answer: { kind: "TARGETS", value: [] },
      },
    ],
  },
};

const singletonTarget: ImportSessionGuidedReviewV1 = {
  ...flatDecision,
  focus: {
    ...focusBase,
    control: "TARGETS",
    options: [
      {
        label: "Cozinha nova",
        answer: { kind: "TARGETS", value: [target] },
      },
    ],
  },
};

const laborCategory: ImportSessionGuidedReviewV1 = {
  ...flatDecision,
  focus: {
    ...focusBase,
    control: "LABOR_CATEGORY",
    options: [
      {
        label: "Eletricista",
        answer: {
          kind: "LABOR_CATEGORY",
          value: LaborCategory.ELETRICISTA,
        },
      },
    ],
  },
};

const answeringWithoutFocus: ImportSessionGuidedReviewV1 = {
  progress: "ANSWERING",
  focus: null,
  actions: ["CONTINUE_ANSWERING"],
};

const readyWithPendingWithoutFocus: ImportSessionGuidedReviewV1 = {
  progress: "READY_WITH_PENDING",
  focus: null,
  actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
};

const ready: ImportSessionGuidedReviewV1 = {
  progress: "READY",
  focus: null,
  actions: ["REVIEW_READY"],
};

// @ts-expect-error ANSWING exposes exactly the continue action.
const wrongAnsweringAction: ImportSessionGuidedReviewV1 = {
  progress: "ANSWERING",
  focus: null,
  actions: ["REVIEW_READY"],
};

const wrongPendingActions: ImportSessionGuidedReviewV1 = {
  progress: "READY_WITH_PENDING",
  focus: null,
  actions: [
    "REVIEW_READY",
    // @ts-expect-error Pending-ready exposes both actions in canonical order.
    "CONTINUE_ANSWERING",
  ],
};

// @ts-expect-error Guided review is flat and has no compatibility version.
const versioned: ImportSessionGuidedReviewV1 = { ...flatDecision, version: 1 };

const nested: ImportSessionGuidedReviewV1 = {
  ...flatDecision,
  // @ts-expect-error Question/line objects are not part of the domain wire.
  focus: { question: {}, line: {}, control: {} },
};

const twoTargets: ImportSessionGuidedReviewV1 = {
  ...flatDecision,
  focus: {
    ...focusBase,
    control: "TARGETS",
    options: [
      {
        label: "Dois destinos",
        answer: {
          kind: "TARGETS",
          // @ts-expect-error R1 target answers are source-only or one target.
          value: [target, target],
        },
      },
    ],
  },
};

const mismatchedControl: ImportSessionGuidedReviewV1 = {
  ...flatDecision,
  focus: {
    ...focusBase,
    control: "DECISION",
    options: [
      {
        label: "Material",
        // @ts-expect-error A DECISION focus accepts only DECISION answers.
        answer: { kind: "EXPENSE_TYPE", value: "MATERIAL_CONSTRUCAO" },
      },
    ],
  },
};

const nullLabor: ImportSessionGuidedReviewV1 = {
  ...flatDecision,
  focus: {
    ...focusBase,
    control: "LABOR_CATEGORY",
    options: [
      {
        label: "Sem categoria",
        // @ts-expect-error Guided labor options must resolve to a category.
        answer: { kind: "LABOR_CATEGORY", value: null },
      },
    ],
  },
};

const browserMetadata: ImportSessionGuidedReviewV1 = {
  ...sourceOnly,
  focus: {
    ...focusBase,
    control: "TARGETS",
    options: [
      {
        label: "Somente em Minhas finanças",
        // @ts-expect-error Labels are server-owned; options carry no browser metadata.
        projectLabel: "Minhas finanças",
        roomLabel: null,
        answer: { kind: "TARGETS", value: [] },
      },
    ],
  },
};

// @ts-expect-error READY never has an answer focus.
const readyWithFocus: ImportSessionGuidedReviewV1 = {
  progress: "READY",
  focus: flatDecision.focus,
  actions: ["REVIEW_READY"],
};

void [
  flatDecision,
  sourceOnly,
  singletonTarget,
  laborCategory,
  answeringWithoutFocus,
  readyWithPendingWithoutFocus,
  ready,
  wrongAnsweringAction,
  wrongPendingActions,
  versioned,
  nested,
  twoTargets,
  mismatchedControl,
  nullLabor,
  browserMetadata,
  readyWithFocus,
];
