import { render, screen } from "@testing-library/react";
import { ProjectType, type NavModule } from "@reformaflow/domain";
import { describe, expect, it, vi } from "vitest";
import { MaisSheet } from "./MaisSheet";

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children: React.ReactNode;
};

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: LinkProps) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const basePath = "/projects/project-1";
const secondary: NavModule[] = [
  {
    slug: "plants",
    label: "Minhas Plantas",
    iconName: "Sprout",
    module: "plantsAi",
  },
  {
    slug: "reminders",
    label: "Lembretes",
    iconName: "Bell",
    module: "reminders",
  },
  {
    slug: "plants-ai",
    label: "Diagnóstico IA",
    iconName: "ScanSearch",
    module: "plantsAi",
  },
];

const baseProps: React.ComponentProps<typeof MaisSheet> = {
  open: true,
  project: {
    id: "project-1",
    name: "Minhas plantas",
    type: ProjectType.PLANTAS,
  },
  basePath,
  pathname: basePath + "/plants-ai/diagnosis",
  secondary,
  isAdmin: false,
  onClose: vi.fn(),
  onLogout: vi.fn(),
};

describe("MaisSheet", () => {
  it("preserves supplied order and marks only the exact owning route active", () => {
    const { rerender } = render(<MaisSheet {...baseProps} />);

    const links = screen.getAllByRole("link");
    expect(
      links.map((link) => [
        link.textContent?.trim(),
        link.getAttribute("href"),
      ]),
    ).toEqual([
      ["Minhas Plantas", basePath + "/plants"],
      ["Lembretes", basePath + "/reminders"],
      ["Diagnóstico IA", basePath + "/plants-ai"],
    ]);

    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).not.toHaveAttribute("aria-current");

    rerender(
      <MaisSheet {...baseProps} pathname={basePath + "/plants/profile"} />,
    );

    expect(
      screen.getByRole("link", { name: "Minhas Plantas" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "Diagnóstico IA" }),
    ).not.toHaveAttribute("aria-current");
  });
});
