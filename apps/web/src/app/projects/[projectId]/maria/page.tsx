'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { MariaChatBody } from './_components/MariaChatBody';

/**
 * Tela "Maria" — copiloto financeiro em tela cheia no app mobile (protótipo
 * `docs/prototipo-mobile/app-maria.html`). O corpo da conversa (mensagens,
 * dock, voz, sheet de edição) vive em `MariaChatBody`, reusado também pelo
 * passo final do onboarding (`MariaInsightStep`) para abrir a Maria sem sair
 * da jornada.
 */
export default function MariaPage() {
  const params = useParams<{ projectId: string }>();

  return (
    <section className="pessoal-minimal-maria flex h-full min-h-0 flex-col">
      <header className="pessoal-minimal-page-header flex items-center gap-3 rounded-2xl border border-lifeone-hairline bg-white px-4 py-3 shadow-lifeone-card">
        <Link
          href={`/projects/${params.projectId}/monthly`}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2"
          aria-label="Voltar para hoje"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-lifeone-ink text-white">
          <Sparkles className="h-5 w-5" />
          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-lifeone-ink">Maria</h1>
          <p className="text-[12px] font-semibold text-lifeone-ink-3">sabe do seu mês inteiro · fala e ouve</p>
        </div>
      </header>

      <MariaChatBody projectId={params.projectId as string} />
    </section>
  );
}
