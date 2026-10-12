import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ImportSessionAmountMeaning,
  type ImportObservationQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { ImportConversationBody } from "./ImportConversationBody";

const mocks = vi.hoisted(() => ({
  editQuestion: vi.fn(),
  conversation: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-owner" }),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("../_hooks/useImportConversation", () => ({
  useImportConversation: () => mocks.conversation,
}));
vi.mock("../_hooks/useImportSessions", () => ({
  useImportUserId: () => "user-selection",
  useCancelImportSession: () => ({ cancel: vi.fn() }),
}));
vi.mock("../_hooks/useImportManualOptions", () => ({
  useImportManualOptions: () => ({
    ownerProjectId: "project-owner",
    candidates: [],
    projects: [],
    pending: false,
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock("../_hooks/useImportCatalog", () => ({
  useImportCatalog: () => ({
    names: { project: vi.fn(), card: vi.fn() },
  }),
}));
vi.mock("@/components/agent/useSpeechRecognition", () => ({
  useSpeechRecognition: () => ({
    stop: vi.fn(),
    start: vi.fn(),
    listening: false,
    supported: false,
  }),
}));
vi.mock("./ImportQuestionViewportOwner", () => ({
  ImportQuestionViewportOwner: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("./ImportFocusedQuestion", () => ({
  ImportFocusedQuestion: () => null,
  IMPORT_QUESTION_FIELD_LABEL: { merchant: "fornecedor" },
}));
vi.mock("./ImportLocalDocuments", () => ({
  ImportLocalDocuments: () => null,
}));
vi.mock("./ImportResumeUpload", () => ({ ImportResumeUpload: () => null }));
vi.mock("./ImportIgnoredObservations", () => ({
  ImportIgnoredObservations: () => null,
}));
vi.mock("./ImportReviewBlockerNotice", () => ({
  ImportReviewBlockerNotice: () => null,
  ImportDeclaredFacts: () => null,
}));
vi.mock("./ImportProposalCard", () => ({ ImportProposalCard: () => null }));
vi.mock("./ImportReceipt", () => ({ ImportReceipt: () => null }));

const answered = (lineId: string): ImportObservationQuestionV1 => ({
  id: `answered-${lineId}`,
  lineIds: [lineId],
  field: "merchant",
  text: `Fornecedor de ${lineId}`,
  subject: {
    kind: "OBSERVATION",
    observationId: `observation-${lineId}`,
    meaningContext: null,
  },
  answerState: "DECLARED",
});

const view: ImportSessionViewV1 = {
  version: 1,
  id: "session-selection",
  ownerProjectId: "project-owner",
  cardId: "card-1",
  state: "DRAFT",
  revision: 4,
  expiresAt: "2026-10-18T00:00:00.000Z",
  attachments: [],
  lines: ["line-a", "line-b"].map((id) => ({
    id,
    observationIds: [`observation-${id}`],
    titulo: `Compra ${id}`,
    fornecedor: "Fornecedor guardado",
    tipoDespesa: null,
    categoriaMaoDeObra: null,
    amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    amountCents: id === "line-a" ? 12_345 : 6_789,
    installmentCount: 1,
    dataCompra: "2026-10-10",
    firstDueDate: null,
    targets: [],
    decision: { kind: "CREATE", acceptNaturalDuplicate: false },
  })),
  selectedLineIds: ["line-b"],
  questions: [answered("line-a"), answered("line-b")],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["RESOLVE", "CANCEL"],
};

beforeEach(() => {
  mocks.editQuestion.mockReset();
  mocks.conversation = {
    userId: "user-selection",
    view,
    question: null,
    error: null,
    busy: false,
    guided: null,
    result: null,
    review: false,
    messages: [],
    literal: "",
    attachmentId: null,
    editingQuestionId: null,
    focus: undefined,
    openReview: vi.fn(),
    readResult: vi.fn(),
    saveDeclaration: vi.fn(),
    saveFocusedDraft: vi.fn(),
    editQuestion: mocks.editQuestion,
    startGuidedAnswer: vi.fn(),
    recover: vi.fn(),
    addToSelection: vi.fn(),
    removeFromSelection: vi.fn(),
    setLiteral: vi.fn(),
    setVoiceLiteral: vi.fn(),
    setAttachmentId: vi.fn(),
  };
});
afterEach(cleanup);

it("offers edit only for answered lines that remain selected", () => {
  render(
    <ImportConversationBody
      sessionId={view.id}
      documents={
        {
          busy: false,
          error: null,
          notice: null,
          recover: vi.fn(),
          analyze: vi.fn(),
        } as never
      }
    />,
  );

  expect(
    screen.queryByRole("button", {
      name: "Editar compra line-a: fornecedor",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: "Editar compra line-b: fornecedor",
    }),
  ).toBeEnabled();
  expect(mocks.editQuestion).not.toHaveBeenCalled();
});
