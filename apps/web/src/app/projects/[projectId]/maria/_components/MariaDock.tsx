'use client';

import { Mic } from 'lucide-react';

export const MARIA_SUGGESTIONS = [
  { key: 'posso', label: 'Posso gastar R$ 500?' },
  { key: 'mercado', label: 'Quanto gastei com mercado?' },
  { key: 'fecho', label: 'Como fecho o mês?' },
] as const;

export const VOICE_LAUNCH_CHIP_LABEL = '🎙 lançar por voz';

interface Props {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (text: string) => void;
  onMic: () => void;
  listening: boolean;
  micSupported: boolean;
  disabled: boolean;
}

export function MariaDock({ input, onInputChange, onSubmit, onMic, listening, micSupported, disabled }: Props) {
  return (
    <div className="pessoal-minimal-maria-dock sticky bottom-0 z-10 -mx-4 bg-gradient-to-t from-lifeone-surface via-lifeone-surface/95 to-transparent px-4 pb-2 pt-3">
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        {MARIA_SUGGESTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onSubmit(s.label)}
            disabled={disabled}
            className="min-h-[44px] shrink-0 whitespace-nowrap rounded-full border border-lifeone-hairline bg-white px-4 py-2.5 text-[13px] font-semibold text-lifeone-ink-2 disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onMic}
          disabled={disabled || !micSupported}
          className="min-h-[44px] shrink-0 whitespace-nowrap rounded-full border border-lifeone-hairline bg-white px-4 py-2.5 text-[13px] font-semibold text-lifeone-ink-2 disabled:opacity-50"
        >
          {VOICE_LAUNCH_CHIP_LABEL}
        </button>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          onSubmit(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={listening ? 'Ouvindo…' : 'Pergunte ou lance… “paguei 30 de uber”'}
          disabled={disabled}
          className="min-h-[44px] flex-1 rounded-2xl border border-lifeone-hairline bg-white px-4 py-3 text-[15px] font-medium text-lifeone-ink shadow-lifeone-card disabled:opacity-60"
        />
        <button
          type="button"
          onClick={onMic}
          disabled={disabled || !micSupported}
          aria-label="Falar"
          className={`flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-2xl text-white disabled:opacity-50 ${
            listening ? 'bg-red-600' : 'bg-emerald-700'
          }`}
        >
          <Mic className="h-5 w-5" />
        </button>
      </form>
    </div>
  );
}
