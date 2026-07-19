import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackButton } from "./FeedbackButton";

const { apiPostMock } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    post: apiPostMock,
  },
}));

describe("FeedbackButton", () => {
  it("shows API error message when submit fails", async () => {
    apiPostMock.mockRejectedValueOnce(new Error("feedback indisponivel"));

    render(<FeedbackButton variant="light" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Enviar feedback" }));
    await user.type(screen.getByPlaceholderText("Escreva aqui..."), "teste");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    expect(await screen.findByText("feedback indisponivel")).toBeInTheDocument();
    expect(apiPostMock).toHaveBeenCalledWith("/feedback", { message: "teste" });
  });
});
