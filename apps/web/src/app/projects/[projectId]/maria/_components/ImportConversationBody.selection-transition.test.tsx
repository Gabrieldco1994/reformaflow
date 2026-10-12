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

const LINE_A_ID = "550e8400-e29b-41d4-a716-446655440001";
const LINE_B_ID = "550e8400-e29b-41d4-a716-446655440002";
const OBSERVATION_A_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c1";
const OBSERVATION_B_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c2";
const QUESTION_A_ID = "9fd160aa-52b6-4df1-bb10-9a179900a211";
const QUESTION_B_ID = "9fd160aa-52b6-4df1-bb10-9a179900a212";

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

const answered = (
  lineId: string,
  observationId: string,
  questionId: string,
): ImportObservationQuestionV1 => ({
  id: questionId,
  lineIds: [lineId],
  field: "merchant",
  text: "Estabelecimento informado",
  subject: {
    kind: "OBSERVATION",
    observationId,
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
  lines: [
    {
      id: LINE_A_ID,
      observationIds: [OBSERVATION_A_ID],
      titulo: "Liquidificador",
      fornecedor: "Fornecedor guardado",
      tipoDespesa: null,
      categoriaMaoDeObra: null,
      amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
      amountCents: 12_345,
      installmentCount: 1,
      dataCompra: "2026-10-10",
      firstDueDate: null,
      targets: [],
      decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    },
    {
      id: LINE_B_ID,
      observationIds: [OBSERVATION_B_ID],
      titulo: "Geladeira",
      fornecedor: "Fornecedor guardado",
      tipoDespesa: null,
      categoriaMaoDeObra: null,
      amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
      amountCents: 6_789,
      installmentCount: 2,
      dataCompra: "2026-10-10",
      firstDueDate: null,
      targets: [],
      decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    },
  ],
  selectedLineIds: [LINE_B_ID],
  questions: [
    answered(LINE_A_ID, OBSERVATION_A_ID, QUESTION_A_ID),
    answered(LINE_B_ID, OBSERVATION_B_ID, QUESTION_B_ID),
  ],
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

  expect(screen.queryByRole("button", { name: /550e8400-e29b/ })).toBeNull();
  expect(
    screen.getByRole("button", {
      name: /Editar compra Fornecedor guardado.*Geladeira.*10\/10\/2026.*R\$ 67,89.*Total.*2 parcelas: fornecedor/,
    }),
  ).toBeEnabled();
  expect(mocks.editQuestion).not.toHaveBeenCalled();
  expect(document.body.textContent ?? "").not.toMatch(
    /550e8400-e29b-41d4-a716-44665544000[12]|6ba7b810-9dad-11d1-80b4-00c04fd430c[12]|amountMeaning/i,
  );
});

it("renders guided response context without line or observation identifiers", () => {
  mocks.conversation.guided = {
    lineId: LINE_B_ID,
    observationId: OBSERVATION_B_ID,
    literal: "Estabelecimento informado",
  };

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

  expect(screen.getByText(/Resposta recebida/)).toHaveTextContent(
    /Fornecedor guardado.*Geladeira.*10\/10\/2026.*R\$ 67,89.*Total.*2 parcelas/,
  );
  expect(
    screen.getByRole("button", { name: /Editar compra/ }),
  ).toHaveAccessibleName(/Geladeira/);
  expect(document.body.textContent ?? "").not.toMatch(
    /550e8400-e29b-41d4-a716-44665544000[12]|6ba7b810-9dad-11d1-80b4-00c04fd430c[12]|amountMeaning/i,
  );
  for (const button of screen.getAllByRole("button")) {
    expect(button).not.toHaveAccessibleName(
      /550e8400-e29b-41d4-a716-44665544000[12]|6ba7b810-9dad-11d1-80b4-00c04fd430c[12]|amountMeaning/i,
    );
  }
});
