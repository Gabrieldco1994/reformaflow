'use client';

import { useEffect, useState } from 'react';
import { Camera, CreditCard, Keyboard, Landmark, Mic, X } from 'lucide-react';

export type LaunchMode = 'escrito' | 'voz' | 'fatura' | 'extrato';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (mode: LaunchMode) => void;
  /** Voz depende da Web Speech API; sem suporte, escondemos o card. */
  voiceSupported?: boolean;
}

interface OptionCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  onClick: () => void;
  accent: string;
}

function OptionCard({ icon: Icon, title, subtitle, onClick, accent }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl border border-darc-linen bg-lifeone-surface px-4 py-3 text-left transition-transform active:scale-[0.99]"
    >
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${accent}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold leading-tight text-darc-velvet">{title}</span>
        <span className="mt-0.5 block truncate text-[12px] leading-tight text-darc-velvet/60">{subtitle}</span>
      </span>
    </button>
  );
}

/**
 * Menu de modo do "+" mobile: escolhe a experiência de lançamento (Escrito / Voz /
 * Foto). Apenas apresentacional — o container decide qual jornada abrir. Foto abre
 * uma sub-tela com "Fatura de cartão" e "Extrato bancário" (as APIs já aceitam imagem).
 */
export function MobileLaunchModeSheet({ open, onClose, onPick, voiceSupported = true }: Props) {
  const [view, setView] = useState<'root' | 'foto'>('root');

  // Toda reabertura começa na raiz (critério de aceite: o "+" sempre mostra os 3 modos).
  useEffect(() => {
    if (open) setView('root');
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div
        className="pessoal-minimal-backdrop fixed inset-0 z-40 bg-darc-velvet/60 backdrop-blur-sm lg:hidden"
        onClick={onClose}
        aria-hidden
      />
      <section
        data-mobile-sheet="launch-mode"
        className="pessoal-minimal-launch-sheet fixed inset-x-0 bottom-0 z-50 max-h-[96dvh] overflow-y-auto rounded-t-[28px] border border-darc-linen bg-lifeone-surface px-4 pb-6 pt-3 lg:hidden"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold text-darc-velvet">
            {view === 'root' ? 'Como quer lançar?' : 'Importar por foto'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-darc-velvet/70 hover:bg-darc-linen/60"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {view === 'root' ? (
          <div className="space-y-2.5 pt-1">
            <OptionCard
              icon={Keyboard}
              title="Escrito"
              subtitle="Teclado rápido — valor, origem e descrição"
              accent="bg-darc-velvet text-white"
              onClick={() => onPick('escrito')}
            />
            {voiceSupported && (
              <OptionCard
                icon={Mic}
                title="Voz"
                subtitle="Fale a despesa — mãos livres"
                accent="bg-[#E8F0EC] text-[#2F7D5B]"
                onClick={() => onPick('voz')}
              />
            )}
            <OptionCard
              icon={Camera}
              title="Foto"
              subtitle="Print ou foto de fatura / extrato"
              accent="bg-[#FBEBDC] text-[#B5803A]"
              onClick={() => setView('foto')}
            />
          </div>
        ) : (
          <div className="space-y-2.5 pt-1">
            <OptionCard
              icon={CreditCard}
              title="Foto da fatura"
              subtitle="Print/foto da fatura do cartão"
              accent="bg-[#FBEBDC] text-[#B5803A]"
              onClick={() => onPick('fatura')}
            />
            <OptionCard
              icon={Landmark}
              title="Foto do extrato"
              subtitle="Print/foto do extrato da conta"
              accent="bg-[#E8F0EC] text-[#2F7D5B]"
              onClick={() => onPick('extrato')}
            />
            <button
              type="button"
              onClick={() => setView('root')}
              className="min-h-11 w-full rounded-2xl px-4 text-[13px] font-medium text-darc-velvet/60 hover:bg-darc-linen/40"
            >
              ← Voltar
            </button>
          </div>
        )}
      </section>
    </>
  );
}
