'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  variant?: 'auto' | 'center' | 'sheet';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  zIndex?: string; // e.g. 'z-60', 'z-[70]'
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

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(() => setMounted(true));
    } else {
      document.body.style.overflow = '';
      setMounted(false);
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  const isSheetOnly = variant === 'sheet';
  const isCenterOnly = variant === 'center';

  const containerClasses = isCenterOnly
    ? 'items-center justify-center'
    : isSheetOnly
      ? 'items-end justify-center'
      : 'items-end justify-center md:items-center';

  const panelClasses = isCenterOnly
    ? `${sizeMap[size]} max-h-[90vh] rounded-2xl mx-4 transition-all duration-200 ${mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`
    : isSheetOnly
      ? `w-full ${sizeMap[size]} max-h-[92vh] rounded-t-3xl transition-transform duration-300 ${mounted ? 'translate-y-0' : 'translate-y-full'}`
      : `w-full ${sizeMap[size]} max-h-[92vh] rounded-t-3xl md:rounded-2xl md:mx-4 transition-all duration-300 ${mounted ? 'translate-y-0 md:opacity-100 md:scale-100' : 'translate-y-full md:translate-y-0 md:opacity-0 md:scale-95'}`;

  const content = (
    <div
      ref={overlayRef}
      className={`fixed inset-0 ${zIndex ?? 'z-50'} flex ${containerClasses} bg-darc-velvet/85 backdrop-blur-sm transition-opacity duration-200 ${mounted ? 'opacity-100' : 'opacity-0'}`}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
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
  // Usar apenas em modais aninhados; modais top-level ficam inline para preservar
  // DOM ordering (seletores .first() em testes E2E dependem disso).
  return portal ? createPortal(content, document.body) : content;
}
