'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayLock } from './use-overlay-lock';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  variant?: 'auto' | 'center' | 'sheet';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  zIndex?: string;
  /** Renderiza via createPortal em document.body. Use apenas em modais aninhados
   *  dentro de outro Modal (overflow-y-auto) para escapar do stacking context. */
  portal?: boolean;
}

const sizeMap = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

// Pilha compartilhada dos modais abertos (por identidade de instância, não por
// posição no DOM): com modais aninhados (ex.: ExpenseFormModal > Criar despesa
// em outro projeto via portal), Escape deve fechar só o topo da pilha — um
// listener por modal na mesma `document` dispara em ordem de registro, então
// sem essa checagem os dois fechariam juntos.
let modalStack: number[] = [];
let modalIdSeq = 0;

export function Modal({
  open,
  onClose,
  title,
  children,
  variant = 'auto',
  size = 'md',
  zIndex,
  portal = false,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const idRef = useRef<number | null>(null);
  if (idRef.current === null) idRef.current = ++modalIdSeq;

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => setMounted(true));
    } else {
      setMounted(false);
    }
  }, [open]);

  useOverlayLock(open);

  // Só o modal no topo da pilha fecha com Escape — evita fechar o modal pai
  // "de baixo" quando um modal aninhado (ex.: portal=true) está por cima.
  useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    modalStack.push(id);
    return () => {
      modalStack = modalStack.filter((stacked) => stacked !== id);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const id = idRef.current!;
      if (modalStack[modalStack.length - 1] !== id) return;
      onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const isSheetOnly = variant === 'sheet';
  const isCenterOnly = variant === 'center';

  const containerClasses = isCenterOnly
    ? 'items-center justify-center'
    : isSheetOnly
      ? 'items-end justify-center'
      : 'items-end justify-center md:items-center';

  const panelClasses = isCenterOnly
    ? `${sizeMap[size]} max-h-[90dvh] rounded-2xl mx-4 transition-all duration-200 ${mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`
    : isSheetOnly
      ? `w-full ${sizeMap[size]} max-h-[92dvh] rounded-t-3xl transition-transform duration-300 ${mounted ? 'translate-y-0' : 'translate-y-full'}`
      : // variante padrão ('auto'): SEM scale no desktop — scale encolhe geometricamente
        // os elementos internos (ex.: alvo de toque de 44px) durante os ~300ms da
        // transição, medível via getBoundingClientRect logo após abrir. Mantém
        // fade + slide-up (translate-y), só troca o "zoom-in" por opacidade.
        `w-full ${sizeMap[size]} max-h-[92dvh] rounded-t-3xl md:rounded-2xl md:mx-4 transition-all duration-300 ${mounted ? 'translate-y-0 md:opacity-100' : 'translate-y-full md:translate-y-0 md:opacity-0'}`;

  const content = (
    <div
      ref={overlayRef}
      className={`fixed inset-0 ${zIndex ?? 'z-50'} flex ${containerClasses} bg-darc-velvet/85 backdrop-blur-sm transition-opacity duration-200 ${mounted ? 'opacity-100' : 'opacity-0'}`}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        data-mobile-sheet="modal"
        className={`bg-white shadow-darc-hero overflow-y-auto border border-darc-linen ${panelClasses}`}
      >
        {!isCenterOnly && (
          <div className="md:hidden flex justify-center pt-3 pb-1">
            <div className="h-1.5 w-12 rounded-full bg-darc-linen/80" />
          </div>
        )}
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-white border-b border-darc-linen">
          <h2 className="font-editorial italic text-xl text-darc-maroon">{title}</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-darc-linen/40 active:bg-darc-linen/60 transition-colors"
            aria-label="Fechar"
          >
            <X className="w-5 h-5 text-darc-maroon" />
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );

  // ponytail: portal=true escapa do stacking context do pai (overflow-y-auto).
  // Usar apenas em modais aninhados; top-level fica inline (preserva DOM ordering).
  return portal ? createPortal(content, document.body) : content;
}
