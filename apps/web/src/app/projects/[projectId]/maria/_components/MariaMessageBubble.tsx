'use client';

import { Volume2, Square } from 'lucide-react';
import type { ChatMessage } from '@/components/agent/useFinancialAgent';
import { detectPendingExpenseConfirmation } from '../_lib/pending-expense';
import { detectVerdict } from '../_lib/verdict';

interface Props {
  message: ChatMessage;
  index: number;
  precedingUserText: string;
  confirmed: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  speaking: boolean;
  ttsSupported: boolean;
  onToggleSpeak: () => void;
}

/** Bolha em negrito para valores em R$ (piso tipográfico: line-height generoso). */
function formatInlineBold(text: string) {
  const parts = text.split(/(R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/g);
  return parts.map((part, i) =>
    /^R\$/.test(part) ? (
      <b key={i} className="font-semibold text-lifeone-ink">
        {part}
      </b>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function MariaMessageBubble({
  message,
  precedingUserText,
  confirmed,
  onConfirm,
  onEdit,
  speaking,
  ttsSupported,
  onToggleSpeak,
}: Props) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="minimal-chat-bubble minimal-chat-bubble--user ml-auto max-w-[86%] rounded-[18px] rounded-br-md bg-lifeone-ink px-4 py-3 text-[15px] font-medium leading-6 text-white">
        {message.content}
      </div>
    );
  }

  const pending = detectPendingExpenseConfirmation(message);
  if (pending) {
    return (
      <div className="max-w-[86%] space-y-2">
        <div className="minimal-chat-bubble rounded-[18px] rounded-bl-md border border-lifeone-hairline bg-white px-4 py-3 text-[15px] leading-6 text-lifeone-ink-2 shadow-lifeone-card">
          Entendi assim — confere?
        </div>
        <div
          className={`minimal-soft-card rounded-2xl border-[1.5px] border-dashed border-emerald-200 bg-emerald-50 p-4 ${confirmed ? 'opacity-70' : ''}`}
        >
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-800">
            nova despesa
          </p>
          <p className="mt-1.5 text-2xl font-extrabold tracking-tight text-lifeone-ink">
            {pending.valorLabel}
          </p>
          <p className="mt-1.5 text-[13px] font-medium leading-6 text-lifeone-ink-2">
            {pending.detalhe}
          </p>
          {!confirmed && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={onConfirm}
                className="min-h-[44px] flex-1 rounded-xl bg-emerald-700 text-[14px] font-bold text-white"
              >
                Confirmar
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="min-h-[44px] flex-1 rounded-xl border border-lifeone-hairline bg-white text-[14px] font-bold text-lifeone-ink-2"
              >
                Editar
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const verdict = detectVerdict(precedingUserText, message.content);

  return (
    <div className="max-w-[86%] space-y-2">
      <div className="minimal-chat-bubble rounded-[18px] rounded-bl-md border border-lifeone-hairline bg-white px-4 py-3 text-[15px] leading-6 text-lifeone-ink-2 shadow-lifeone-card">
        {formatInlineBold(message.content)}
        {ttsSupported && (
          <button
            type="button"
            onClick={onToggleSpeak}
            aria-label={speaking ? 'Parar áudio' : 'Ouvir resposta'}
            className="mt-2 flex min-h-[44px] items-center gap-1 rounded-full border border-lifeone-hairline px-2.5 py-1 text-[11px] font-semibold text-lifeone-ink-3"
          >
            {speaking ? <Square className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
            {speaking ? 'Parar' : 'Ouvir'}
          </button>
        )}
      </div>
      {verdict && (
        <div
          className={`rounded-2xl border px-3.5 py-3 ${
            verdict.tone === 'good'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <p className="text-sm font-bold leading-5">
            {verdict.tone === 'good' ? 'Cabe no plano.' : 'Não cabe no plano.'}
          </p>
        </div>
      )}
    </div>
  );
}
