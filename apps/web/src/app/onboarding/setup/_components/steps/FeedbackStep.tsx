'use client';

import { useState } from 'react';
import { MessageSquareHeart, SkipForward, Star } from 'lucide-react';
import { api } from '@/lib/api';

interface FeedbackStepProps {
  /** Chamado ao concluir (com ou sem envio) — avança para o "Pronto"/cockpit. */
  onDone: () => void;
}

const RATING_LABELS: Record<number, string> = {
  1: 'Muito difícil',
  2: 'Difícil',
  3: 'Ok',
  4: 'Fácil',
  5: 'Muito fácil',
};

/**
 * Último passo do onboarding, antes do "Pronto"/redirect ao cockpit: pede uma
 * nota de 1 a 5 estrelas ("quão fácil achou usar o app") e um comentário livre.
 * Envia para o MESMO recurso de feedback (`POST /feedback`) já usado pelo
 * botão de feedback do app — não é um sistema paralelo, só mais uma origem.
 */
export function FeedbackStep({ onDone }: FeedbackStepProps) {
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending'>('idle');

  async function handleSubmit() {
    if (status === 'sending') return;
    if (!rating && !message.trim()) {
      onDone();
      return;
    }
    setStatus('sending');
    try {
      await api.post('/feedback', {
        message: message.trim() || `Nota de facilidade de uso: ${rating}/5`,
        rating: rating || undefined,
      });
    } catch {
      // ponytail: feedback é acessório — não trava o fim da jornada por erro de rede
    }
    onDone();
  }

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-lifeone-ink text-white">
          <MessageSquareHeart className="h-4 w-4" />
        </div>
        <h2 className="text-[18px] font-bold text-lifeone-ink">O que achou do LifeOne até aqui?</h2>
      </div>
      <p className="mt-2 text-[13px] text-lifeone-ink-3">
        O quanto fácil achou usar o app nesse começo?
      </p>

      <div className="mt-4 flex items-center justify-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} estrela${n === 1 ? '' : 's'}`}
            onClick={() => setRating(n)}
            className="p-1"
          >
            <Star
              className={`h-8 w-8 transition-colors ${
                n <= rating ? 'fill-lifeone-blue text-lifeone-blue' : 'text-lifeone-hairline'
              }`}
            />
          </button>
        ))}
      </div>
      {rating > 0 && (
        <p className="mt-1 text-center text-[12px] font-medium text-lifeone-ink-3">
          {RATING_LABELS[rating]}
        </p>
      )}

      <textarea
        rows={4}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Quer contar mais alguma coisa? (opcional)"
        className="mt-4 w-full rounded-[12px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-3/60 focus:outline-none focus:ring-2 focus:ring-lifeone-blue/30 resize-none"
      />

      <div className="mt-5 flex flex-col gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={status === 'sending'}
          className="min-h-11 w-full rounded-[12px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-60"
        >
          {status === 'sending' ? 'Enviando…' : 'Enviar e concluir'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
        >
          <SkipForward className="h-3.5 w-3.5" /> Pular
        </button>
      </div>
    </section>
  );
}
