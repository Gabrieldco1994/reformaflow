import type {
  ImportDeclarationAnswerV1,
  ImportSessionQuestionV1,
  ImportTypedDraftAnswerV1,
  ImportTypedGuidedAnswerV1,
} from "@reformaflow/domain";
import { moneyDetail } from "@/lib/money";
import { formatDateOnly } from "./import-format";

export type GuidedDraftField =
  | "decision"
  | "targets"
  | "tipoDespesa"
  | "categoriaMaoDeObra";

export function isGuidedDraftField(
  field: ImportSessionQuestionV1["field"],
): field is GuidedDraftField {
  return (
    field === "decision" ||
    field === "targets" ||
    field === "tipoDespesa" ||
    field === "categoriaMaoDeObra"
  );
}

export const IMPORT_QUESTION_FIELD_LABEL: Record<
  ImportSessionQuestionV1["field"],
  string
> = {
  amountMeaning: "Significado do valor",
  amountCents: "Valor da compra",
  installmentCount: "Quantidade de parcelas",
  dataCompra: "Data da compra",
  firstDueDate: "Primeiro vencimento",
  targets: "Finalidade da compra",
  decision: "Destino da compra",
  tipoDespesa: "Tipo de despesa",
  categoriaMaoDeObra: "Categoria de mão de obra",
  merchant: "Nome do estabelecimento",
  installmentIndex: "Número desta parcela",
};

const QUESTION_COPY: Record<ImportSessionQuestionV1["field"], string> = {
  amountMeaning: "Esse valor é o total da compra ou o valor de uma parcela?",
  amountCents: "Qual é o valor desta compra?",
  installmentCount: "Em quantas parcelas esta compra foi feita?",
  installmentIndex: "Qual é o número desta parcela?",
  dataCompra: "Qual é a data da compra?",
  firstDueDate: "Qual é a data do primeiro vencimento?",
  merchant: "Qual é o nome do estabelecimento?",
  targets: "Qual é a finalidade desta compra?",
  decision: "O que deve acontecer com esta compra?",
  tipoDespesa: "Qual é o tipo de despesa?",
  categoriaMaoDeObra: "Qual é a categoria de mão de obra?",
};

export function importQuestionCopy(question: ImportSessionQuestionV1) {
  if (question.field !== "amountCents") return QUESTION_COPY[question.field];
  if (
    "subject" in question &&
    question.subject.meaningContext === "TOTAL_PURCHASE"
  )
    return "Qual é o total da compra?";
  if (
    "subject" in question &&
    question.subject.meaningContext === "INSTALLMENT_CHARGE"
  )
    return "Qual é o valor desta parcela?";
  return QUESTION_COPY.amountCents;
}

export function declarationFieldLabel(
  answer: ImportDeclarationAnswerV1,
): string {
  return answer.field === "amountCents"
    ? answer.meaningContext === "TOTAL_PURCHASE"
      ? "Total da compra"
      : "Valor da parcela"
    : IMPORT_QUESTION_FIELD_LABEL[answer.field];
}

export function declarationValueLabel(
  answer: ImportDeclarationAnswerV1,
): string {
  if (answer.value === null) return "Não sei informar";
  if (answer.field === "amountCents") return moneyDetail(answer.value);
  if (answer.field === "dataCompra")
    return formatDateOnly(answer.value) ?? "Data inválida";
  if (answer.field === "amountMeaning")
    return answer.value === "TOTAL_PURCHASE"
      ? "Total da compra"
      : "Valor da parcela";
  return String(answer.value);
}

export function typedGuidedValueLabel(
  field: ImportSessionQuestionV1["field"],
  answer: ImportTypedGuidedAnswerV1 | ImportTypedDraftAnswerV1,
) {
  if (answer.kind === "UNKNOWN") return "Não sei informar";
  if (answer.kind === "REMOVE") return "Remover informação guardada";
  if (
    field === "amountCents" &&
    (answer.kind === "KNOWN" || answer.kind === "CENTS") &&
    typeof answer.value === "number"
  )
    return moneyDetail(answer.value);
  if (
    (field === "dataCompra" || field === "firstDueDate") &&
    (answer.kind === "KNOWN" || answer.kind === "DATE") &&
    typeof answer.value === "string"
  )
    return formatDateOnly(answer.value) ?? answer.value;
  if (
    field === "amountMeaning" &&
    (answer.kind === "KNOWN" || answer.kind === "AMOUNT_MEANING")
  )
    return answer.value === "TOTAL_PURCHASE"
      ? "Total da compra"
      : "Valor da parcela";
  if ("value" in answer && typeof answer.value !== "object")
    return String(answer.value);
  return IMPORT_QUESTION_FIELD_LABEL[field];
}
