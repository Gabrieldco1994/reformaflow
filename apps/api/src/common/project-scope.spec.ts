// #483 — a álgebra das lentes decide o que um agregado misto pode somar; um
// engano no tri-state (`null` = irrestrito, `[]` = nega tudo) vira vazamento.
import {
  intersectProjectScope,
  projectScopeIncludes,
  sameProjectScope,
  unionProjectScope,
} from "./project-scope";

describe("project scope (álgebra tri-state)", () => {
  describe("unionProjectScope", () => {
    it("irrestrito absorve qualquer lente", () => {
      expect(unionProjectScope(null, ["a"])).toBeNull();
      expect(unionProjectScope(["a"], null)).toBeNull();
      expect(unionProjectScope(null, null)).toBeNull();
    });

    it("une listas sem duplicar", () => {
      expect(unionProjectScope(["a", "b"], ["b", "c"])).toEqual([
        "a",
        "b",
        "c",
      ]);
    });

    it("duas lentes vazias continuam negando tudo", () => {
      expect(unionProjectScope([], [])).toEqual([]);
    });
  });

  describe("intersectProjectScope", () => {
    it("irrestrito é neutro", () => {
      expect(intersectProjectScope(null, ["a"])).toEqual(["a"]);
      expect(intersectProjectScope(["a"], null)).toEqual(["a"]);
      expect(intersectProjectScope(null, null)).toBeNull();
    });

    it("uma lente vazia nega tudo (fail-closed)", () => {
      expect(intersectProjectScope([], ["a"])).toEqual([]);
      expect(intersectProjectScope(["a"], [])).toEqual([]);
      expect(intersectProjectScope(null, [])).toEqual([]);
    });

    it("mantém só o que as duas lentes autorizam", () => {
      expect(intersectProjectScope(["a", "b"], ["b", "c"])).toEqual(["b"]);
    });

    it("não devolve a mesma referência das entradas (evita mutação acidental)", () => {
      const a = ["a"];
      expect(intersectProjectScope(a, null)).not.toBe(a);
    });
  });

  describe("projectScopeIncludes", () => {
    it("irrestrito alcança qualquer projeto", () => {
      expect(projectScopeIncludes(null, "qualquer")).toBe(true);
    });

    it("lente vazia não alcança nada", () => {
      expect(projectScopeIncludes([], "a")).toBe(false);
    });

    it("lista alcança apenas os ids presentes", () => {
      expect(projectScopeIncludes(["a"], "a")).toBe(true);
      expect(projectScopeIncludes(["a"], "b")).toBe(false);
    });
  });

  describe("sameProjectScope", () => {
    it("irrestrito só é igual a irrestrito", () => {
      expect(sameProjectScope(null, null)).toBe(true);
      expect(sameProjectScope(null, [])).toBe(false);
      expect(sameProjectScope([], null)).toBe(false);
    });

    it("compara por conteúdo, independente da ordem", () => {
      expect(sameProjectScope(["a", "b"], ["b", "a"])).toBe(true);
      expect(sameProjectScope(["a"], ["a", "b"])).toBe(false);
      expect(sameProjectScope([], [])).toBe(true);
    });
  });
});
