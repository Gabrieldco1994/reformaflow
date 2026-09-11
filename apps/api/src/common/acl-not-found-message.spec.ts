/**
 * Achado #5 (security-tenant-lens SEC-3) — a mensagem opaca de bloqueio ACL
 * fail-closed tem que ser a MESMA em todos os pontos, para não vazar qual
 * categoria de objeto foi bloqueada (Fatura vs Despesa vs Recebimento vs
 * Importação). Um único texto genérico, importado de `common/access-rules`,
 * nunca um literal duplicado por serviço.
 */
import { ACL_NOT_FOUND_MESSAGE } from "./access-rules";

describe("ACL_NOT_FOUND_MESSAGE — texto único de bloqueio opaco (#5)", () => {
  it("é um texto genérico, sem referência a um tipo de recurso específico", () => {
    expect(ACL_NOT_FOUND_MESSAGE).toBe("Recurso não encontrado");
    const lower = ACL_NOT_FOUND_MESSAGE.toLowerCase();
    for (const forbidden of ["fatura", "despesa", "recebimento", "importação", "importacao"]) {
      expect(lower).not.toContain(forbidden);
    }
  });
});
