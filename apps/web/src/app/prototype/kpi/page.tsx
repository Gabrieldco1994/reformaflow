import { notFound } from 'next/navigation';

import { PrototypeKpiClient } from './_components/PrototypeKpiClient';

/**
 * Protótipo de aceite visual do design system — DEV apenas.
 *
 * A rota não tem UMA referência em `apps/web/src`: não está em nenhum menu,
 * nenhum link, nenhum teste. Só que "não linkado" não é "não publicado" — o
 * App Router serve todo diretório com `page.tsx`, então `/prototype/kpi` estava
 * no ar em produção, alcançável por quem digitasse a URL.
 *
 * Mesmo guard de `prototype/agent-monitor`: a decisão é do servidor, antes de
 * qualquer render, para que a árvore nem chegue a virar bundle. Por isso o
 * conteúdo (que é client component, tem `onClick`) vive em `_components/`.
 */
export default function PrototypeKpiPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  return <PrototypeKpiClient />;
}
