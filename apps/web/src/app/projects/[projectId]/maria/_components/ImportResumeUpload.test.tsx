import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { ImportResumeUpload } from "./ImportResumeUpload";

const view = (actions: string[]) =>
  ({ id: "s1", attachments: [], actions }) as unknown as ImportSessionViewV1;
const docs = (over = {}) => ({
  canResume: true,
  hasAttempt: false,
  busy: false,
  error: null,
  resume: vi.fn(),
  ...over,
});

describe("ImportResumeUpload", () => {
  it("shows the reselect + consent form when the server allows UPLOAD and no local file exists", () => {
    render(<ImportResumeUpload view={view(["UPLOAD"])} documents={docs()} />);
    expect(screen.getByText(/Selecionar arquivos/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Analisar e guardar rascunho" }),
    ).toBeDisabled();
  });

  it("sends the selected file to resume only after explicit consent submit", () => {
    const documents = docs();
    const { container } = render(
      <ImportResumeUpload view={view(["UPLOAD"])} documents={documents} />,
    );
    const input = container.querySelector('input[type="file"]')!;
    const file = new File(["a;b"], "fatura.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(documents.resume).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Analisar e guardar rascunho" }),
    );
    expect(documents.resume).toHaveBeenCalledWith([file], ["CSV"]);
  });

  it("states the deterministic parser boundary before upload consent", () => {
    render(
      <ImportResumeUpload
        view={view(["UPLOAD"])}
        documents={docs({ supportedFormats: ["CSV", "PDF"] })}
      />,
    );
    expect(
      screen.getByText(/parsers determinísticos locais e do servidor/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nenhum documento é enviado a LLM ou OCR/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/OCR não está disponível/i)).toBeInTheDocument();
  });

  it.each([
    ["server does not offer UPLOAD", view(["ANALYZE"]), docs()],
    ["hook cannot resume", view(["UPLOAD"]), docs({ canResume: false })],
    ["an attempt already exists", view(["UPLOAD"]), docs({ hasAttempt: true })],
  ])("renders no picker when %s", (_n, v, d) => {
    const { container } = render(<ImportResumeUpload view={v} documents={d} />);
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});
