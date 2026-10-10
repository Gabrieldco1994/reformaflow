import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportLocalDocuments } from "./ImportLocalDocuments";
import { workflowFixture } from "../_lib/import-workflow-fixtures";

const documentFile = (name = "compra.png") =>
  new File(["documento sintético"], name, { type: "image/png" });
const picker = () => screen.getByLabelText("Selecionar arquivos");
const consent = () =>
  screen.getByRole("button", { name: "Analisar e guardar rascunho" });

describe("public entry local consent is not the remote outcome", () => {
  it("surfaces an uncertain documentary result without resending consent", async () => {
    const user = userEvent.setup();
    const onConsent = vi.fn();
    const onRecover = vi.fn();
    const file = new File(["documento sintético"], "pendente.csv", {
      type: "text/csv",
    });
    const h = render(<ImportLocalDocuments onConsent={onConsent} />);
    await user.upload(picker(), file);
    await user.click(consent());
    expect(onConsent).toHaveBeenCalledTimes(1);
    expect(onConsent).toHaveBeenCalledWith([file]);
    h.rerender(
      <ImportLocalDocuments
        onConsent={onConsent}
        onRecover={onRecover}
        remoteError="Resultado documental incerto. Consulte o estado guardado."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Resultado documental incerto",
    );
    await user.click(
      screen.getByRole("button", { name: "Consultar estado dos documentos" }),
    );
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onConsent).toHaveBeenCalledTimes(1);
  });
});

describe("ImportLocalDocuments (inactive, local events only)", () => {
  it("X3 keeps remote completion separate from local consent and never reuploads during recovery", async () => {
    const user = userEvent.setup();
    const onConsent = vi.fn();
    const onAnalyze = vi.fn();
    const onRecover = vi.fn();
    const h = render(<ImportLocalDocuments onConsent={onConsent} />);
    await user.upload(picker(), documentFile());
    await user.click(consent());
    const view = workflowFixture();
    view.attachments.push({
      id: "b",
      fileName: "pendente.pdf",
      declaredBytes: 12,
      state: "ATTACHED",
      materializedInSession: false,
      canAnalyze: true,
    });
    view.actions = ["ANALYZE", "CANCEL"];
    h.rerender(
      <ImportLocalDocuments
        view={view}
        onAnalyze={onAnalyze}
        onRecover={onRecover}
        remoteError="Resultado não confirmado."
      />,
    );
    expect(screen.queryByLabelText("Selecionar arquivos")).toBeNull();
    expect(
      screen.getByText(/Análise documental guardada nesta importação/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Analisar documento: pendente/ }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Consultar estado dos documentos" }),
    );
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onAnalyze).not.toHaveBeenCalled();
    h.rerender(
      <ImportLocalDocuments
        view={view}
        onAnalyze={onAnalyze}
        onRecover={onRecover}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Analisar documento: pendente/ }),
    );
    expect(onAnalyze).toHaveBeenCalledWith("b");
    expect(onConsent).toHaveBeenCalledTimes(1);
  });
  it("X3 pending RAW/OFF never offers executable analysis or claims a draft", () => {
    const view = workflowFixture();
    view.attachments[0].materializedInSession = false;
    view.actions = [];
    render(<ImportLocalDocuments view={view} onAnalyze={vi.fn()} />);
    expect(
      screen.getByText(/Análise indisponível para este documento/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Analisar/ })).toBeNull();
    expect(screen.queryByText(/Análise documental guardada/)).toBeNull();
  });
  const fetchSpy = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockClear();
    vi.spyOn(XMLHttpRequest.prototype, "send");
    vi.spyOn(Storage.prototype, "setItem");
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(XMLHttpRequest.prototype.send).not.toHaveBeenCalled();
    expect(Storage.prototype.setItem).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps selection local; explicit documentary consent emits the original File identities once", async () => {
    const user = userEvent.setup();
    const onConsent = vi.fn();
    const files = [documentFile(), documentFile()];
    render(<ImportLocalDocuments onConsent={onConsent} />);
    await user.upload(picker(), files);
    expect(onConsent).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Arquivo selecionado. Nada foi enviado.",
    );
    expect(
      screen.getByText(/Não cria despesas, pagamentos ou rateios/),
    ).toBeInTheDocument();
    expect(screen.getByText(/7 dias sem edição/)).toBeInTheDocument();
    await user.dblClick(consent());
    expect(onConsent).toHaveBeenCalledTimes(1);
    expect(onConsent.mock.calls[0][0]).toHaveLength(2);
    expect(onConsent.mock.calls[0][0][0]).toBe(files[0]);
    expect(onConsent.mock.calls[0][0][1]).toBe(files[1]);
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "Nada foi enviado",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "não confirma que o rascunho foi guardado",
    );
  });

  it("removes by local position, preserves distinct same-name files, and cancels without effects", async () => {
    const user = userEvent.setup();
    const onConsent = vi.fn();
    const first = documentFile();
    const second = documentFile();
    render(<ImportLocalDocuments onConsent={onConsent} />);
    await user.upload(picker(), [first, second]);
    await user.click(
      screen.getByRole("button", { name: "Remover arquivo 1: compra.png" }),
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Remover arquivo 1: compra.png" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancelar seleção" }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(picker()).toHaveValue("");
    expect(picker()).toHaveFocus();
    expect(onConsent).not.toHaveBeenCalled();
    await user.upload(picker(), second);
    await user.click(consent());
    expect(onConsent.mock.calls[0][0][0]).toBe(second);
  });

  it("keeps selection available without a callback, but cannot consent or claim persistence", async () => {
    const user = userEvent.setup();
    render(<ImportLocalDocuments />);
    await user.upload(picker(), documentFile());
    expect(consent()).toBeDisabled();
    expect(screen.getByText(/Análise indisponível/)).toBeInTheDocument();
    await user.click(consent());
    expect(screen.getByRole("status")).toHaveTextContent("Nada foi enviado");
  });

  it.each(["pending", "disabled"] as const)(
    "blocks every mutation while %s, including synthetic submit",
    async (gate) => {
      const user = userEvent.setup();
      const onConsent = vi.fn();
      const { rerender } = render(
        <ImportLocalDocuments onConsent={onConsent} />,
      );
      await user.upload(picker(), documentFile());
      rerender(
        <ImportLocalDocuments onConsent={onConsent} {...{ [gate]: true }} />,
      );
      expect(picker()).toBeDisabled();
      expect(consent()).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Cancelar seleção" }),
      ).toBeDisabled();
      fireEvent.submit(
        screen.getByRole("form", { name: "Documentos para análise" }),
      );
      expect(onConsent).not.toHaveBeenCalled();
    },
  );

  it("locks same-tick submissions before the parent can render pending", async () => {
    const user = userEvent.setup();
    const onConsent = vi.fn();
    render(<ImportLocalDocuments onConsent={onConsent} />);
    await user.upload(picker(), documentFile());
    const form = screen.getByRole("form", { name: "Documentos para análise" });
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(onConsent).toHaveBeenCalledTimes(1);
  });

  it("enforces the normative five-file limit without truncating or replacing valid selection", async () => {
    const user = userEvent.setup();
    const onConsent = vi.fn();
    const files = Array.from({ length: 5 }, (_, i) =>
      documentFile(`compra-${i}.png`),
    );
    render(<ImportLocalDocuments onConsent={onConsent} />);
    await user.upload(picker(), files);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    await user.upload(picker(), documentFile("sexta.png"));
    expect(screen.getByRole("alert")).toHaveTextContent("5 arquivos");
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(onConsent).not.toHaveBeenCalled();
    await user.click(consent());
    expect(onConsent.mock.calls[0][0]).toEqual(files);
  });

  it("accepts exactly 10485760 bytes; rejects empty, oversized and unsupported files explicitly", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onConsent = vi.fn();
    render(<ImportLocalDocuments onConsent={onConsent} />);
    const maximum = documentFile("limite.png");
    Object.defineProperty(maximum, "size", { value: 10485760 });
    await user.upload(picker(), maximum);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    const oversized = documentFile("grande.png");
    Object.defineProperty(oversized, "size", { value: 10485761 });
    for (const invalid of [
      oversized,
      new File([], "vazio.png"),
      documentFile("imagem.heic"),
    ]) {
      await user.upload(picker(), invalid);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
      expect(onConsent).not.toHaveBeenCalled();
    }
  });

  it("accepts normative extensions without pretending the browser MIME proves file contents", async () => {
    const user = userEvent.setup();
    render(<ImportLocalDocuments />);
    for (const extension of [
      "csv",
      "ofx",
      "pdf",
      "xls",
      "xlsx",
      "png",
      "jpeg",
      "jpg",
      "webp",
    ]) {
      await user.upload(
        picker(),
        new File(["sintético"], `documento.${extension}`),
      );
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
      await user.click(
        screen.getByRole("button", { name: "Cancelar seleção" }),
      );
    }
  });
});
