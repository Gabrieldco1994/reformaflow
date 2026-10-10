import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportProposalCard } from "@/app/projects/[projectId]/maria/_components/ImportProposalCard";
import { ImportConversationBody } from "@/app/projects/[projectId]/maria/_components/ImportConversationBody";
import { ImportSessionBody } from "@/app/projects/[projectId]/maria/_components/ImportSessionBody";
import {
  useImportSession,
  useImportUserId,
} from "@/app/projects/[projectId]/maria/_hooks/useImportSessions";
import { useImportCatalog } from "@/app/projects/[projectId]/maria/_hooks/useImportCatalog";
import { describeImportFailure } from "@/app/projects/[projectId]/maria/_lib/import-session-errors";
import "@/app/globals.css";
import "../maria-local-interaction/harness.css";
import "./workflow.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing offline harness root");
const narrow = new URLSearchParams(location.search).has("narrow");
const conversation = new URLSearchParams(location.search).has("conversation");
const recovery = new URLSearchParams(location.search).has("recovery");
function Recovery() {
  const userId = useImportUserId();
  const detail = useImportSession(userId, "session-a");
  const { names } = useImportCatalog(userId, detail.status === "ready");
  if (detail.failure)
    return (
      <p role="alert">
        {describeImportFailure(detail.failure, "detail").message}
      </p>
    );
  return detail.view ? (
    <ImportSessionBody view={detail.view} names={names} />
  ) : (
    <p role="status">Consultando…</p>
  );
}
createRoot(root).render(
  <QueryClientProvider client={new QueryClient()}>
    <main
      className={`workflow-harness ${narrow ? "workflow-narrow" : ""}`}
      data-ui-skin="minimal"
    >
      <header>
        <h1>Workflow M1 — harness offline</h1>
        <p>Dados sintéticos; sem API, cadastro, chat ou ativação.</p>
      </header>
      <div className="workflow-host">
        {recovery ? (
          <Recovery />
        ) : conversation ? (
          <ImportConversationBody sessionId="session-a" />
        ) : (
          <ImportProposalCard sessionId="session-a" />
        )}
      </div>
      {narrow && (
        <aside className="workflow-sidebar">
          Painel lateral sintético aberto
        </aside>
      )}
    </main>
  </QueryClientProvider>,
);
