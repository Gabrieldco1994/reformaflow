'use client';

import { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';

interface FeedbackButtonProps {
  variant?: 'light' | 'dark';
  className?: string;
}

export function FeedbackButton({ variant = 'dark', className = '' }: FeedbackButtonProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');

  async function handleSubmit() {
    if (!message.trim() || status === 'sending') return;
    setStatus('sending');
    try {
      await api.post('/feedback', { message });
      setStatus('done');
      setTimeout(() => {
        setOpen(false);
        setMessage('');
        setStatus('idle');
      }, 1500);
    } catch {
      setStatus('idle');
    }
  }

  const iconColor = variant === 'light' ? 'text-darc-velvet/70' : 'text-darc-velvet/70';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Enviar feedback"
        className={`flex items-center justify-center ${className}`}
      >
        <MessageSquarePlus className={`h-5 w-5 ${iconColor}`} />
      </button>

      <Modal
        open={open}
        onClose={() => { setOpen(false); setMessage(''); setStatus('idle'); }}
        title="Enviar feedback"
        portal
      >
        {status === 'done' ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="text-2xl">✅</span>
            <p className="text-sm text-darc-velvet/80">Obrigado! Feedback enviado.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-darc-velvet/60">
              Conta o que está achando, o que melhoraria ou qualquer bug que encontrou.
            </p>
            <textarea
              autoFocus
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Escreva aqui..."
              className="w-full rounded-xl border border-darc-linen bg-white px-4 py-3 text-sm text-darc-velvet placeholder:text-darc-velvet/30 focus:outline-none focus:ring-2 focus:ring-darc-maroon/30 resize-none"
            />
            <button
              onClick={handleSubmit}
              disabled={!message.trim() || status === 'sending'}
              className="min-h-[44px] w-full rounded-xl bg-darc-maroon px-4 py-3 text-sm font-semibold text-white disabled:opacity-40 active:scale-[.98] transition-transform"
            >
              {status === 'sending' ? 'Enviando…' : 'Enviar'}
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
