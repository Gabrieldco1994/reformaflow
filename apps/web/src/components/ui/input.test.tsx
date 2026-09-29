import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Input } from "./input";
import { Select } from "./select";

it("associates field labels with unique controls while preserving explicit ids", () => {
  render(
    <>
      <Input label="Amount" defaultValue="123" disabled />
      <Input label="Title" defaultValue="Purchase" />
      <Select label="Category" options={[{ value: "other", label: "Other" }]} />
      <Input id="provided-input" label="Supplier" />
      <Select id="provided-select" label="Room" options={[]} />
    </>,
  );
  expect(screen.getByLabelText("Amount")).toHaveValue("123");
  expect(screen.getByLabelText("Amount")).toBeDisabled();
  expect(screen.getByLabelText("Title")).toHaveValue("Purchase");
  const generated = ["Amount", "Title", "Category"].map(
    (label) => screen.getByLabelText(label).id,
  );
  expect(new Set(generated).size).toBe(3);
  expect(screen.getByLabelText("Supplier").id).toBe("provided-input");
  expect(screen.getByLabelText("Room").id).toBe("provided-select");
});
