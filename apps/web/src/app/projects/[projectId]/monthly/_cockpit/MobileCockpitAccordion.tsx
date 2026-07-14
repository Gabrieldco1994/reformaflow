"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export default function MobileCockpitAccordion({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const panelId = `${id}-panel`;
  return (
    <section className="minimal-card overflow-hidden rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] shadow-lifeone-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left text-base font-semibold text-[var(--ck-text)]"
      >
        {title}
        <ChevronDown
          aria-hidden="true"
          className={`h-5 w-5 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
