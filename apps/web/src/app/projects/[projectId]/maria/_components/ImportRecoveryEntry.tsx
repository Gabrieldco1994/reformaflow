"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { ImportRecoveryPanel } from "./ImportRecoveryPanel";
import type { ImportListState } from "../_hooks/useImportSessions";

// Entrada da retomada na página Maria. z-[60] fica acima do painel do widget
// financeiro (z-50) para os CTAs nunca ficarem cobertos.
export function ImportRecoveryEntry({
  activeList,
  onContinue,
}: {
  activeList?: ImportListState;
  onContinue?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (
            activeList?.status === "ready" &&
            activeList.freshness !== "refreshing"
          )
            void activeList.restart();
        }}
        className="mt-3 inline-flex min-h-11 items-center gap-2 self-start rounded-xl border border-lifeone-hairline bg-white px-4 text-[13px] font-semibold text-lifeone-ink-2 shadow-lifeone-card"
      >
        <History className="h-4 w-4" aria-hidden />
        Importações da Maria
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Importações da Maria"
        variant="auto"
        size="lg"
        trapFocus
        bounded
        zIndex="z-[60]"
      >
        {open && (
          <ImportRecoveryPanel
            activeList={activeList}
            onContinue={
              onContinue
                ? (id) => {
                    setOpen(false);
                    onContinue(id);
                  }
                : undefined
            }
          />
        )}
      </Modal>
    </>
  );
}
