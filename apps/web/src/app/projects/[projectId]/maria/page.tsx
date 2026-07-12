'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Sparkles } from 'lucide-react';

export default function MariaPage() {
  const params = useParams<{ projectId: string }>();

  return (
    <section className="mx-auto max-w-xl space-y-4 lg:space-y-6">
      <header className="flex items-center gap-3 rounded-2xl border border-lifeone-hairline bg-white px-4 py-3 shadow-lifeone-card">
        <Link
          href={`/projects/${params.projectId}/monthly`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2"
          aria-label="Voltar para hoje"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">Maria</p>
          <h1 className="text-lg font-bold text-lifeone-ink">Copiloto financeiro</h1>
        </div>
      </header>

      <article className="rounded-3xl border border-lifeone-hairline bg-white p-5 text-lifeone-ink shadow-lifeone-card">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
          <Sparkles className="h-3.5 w-3.5" /> em preparação
        </div>
        <p className="text-sm leading-6 text-lifeone-ink-2">
          A experiência completa da Maria chega no próximo PR. No desktop, o widget atual continua ativo.
        </p>
      </article>
    </section>
  );
}
