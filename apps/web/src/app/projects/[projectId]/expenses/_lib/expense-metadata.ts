import type { ExpenseFormData } from "@/types";

/** A metadata save must not echo financial fields from the loaded expense. */
export function expenseMetadataFromForm(
  form: FormData,
  includeRoom: boolean,
): Partial<ExpenseFormData> {
  const nullable = (key: string) => String(form.get(key) ?? "").trim() || null;
  return {
    tipoDespesa: String(form.get("tipoDespesa") ?? ""),
    categoriaMaoDeObra: nullable("categoriaMaoDeObra"),
    titulo: nullable("titulo"),
    fornecedor: nullable("fornecedor"),
    link: nullable("link"),
    imageUrl: nullable("imageUrl"),
    ...(includeRoom ? { roomId: nullable("roomId") } : {}),
  };
}
