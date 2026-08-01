import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './modal';

function Sut({ open }: { open: boolean }) {
  return (
    <Modal open={open} onClose={vi.fn()} title="Teste">
      <p>conteúdo</p>
    </Modal>
  );
}

describe('useOverlayLock via Modal', () => {
  afterEach(() => {
    cleanup();
    document.body.style.overflow = '';
    delete document.body.dataset.overlayOpen;
  });

  it('marca o body enquanto aberto e limpa ao fechar', () => {
    const { rerender } = render(<Sut open={false} />);
    expect(document.body.dataset.overlayOpen).toBeUndefined();

    rerender(<Sut open />);
    expect(document.body.dataset.overlayOpen).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<Sut open={false} />);
    expect(document.body.dataset.overlayOpen).toBeUndefined();
    expect(document.body.style.overflow).toBe('');
  });

  // Contador compartilhado: o efeito antigo era por modal, então fechar o de
  // cima destravava o scroll com o de baixo ainda aberto.
  it('só destrava quando o ÚLTIMO overlay empilhado fecha', () => {
    const { rerender } = render(
      <>
        <Sut open />
        <Sut open />
      </>,
    );
    expect(document.body.dataset.overlayOpen).toBe('true');

    rerender(
      <>
        <Sut open />
        <Sut open={false} />
      </>,
    );
    expect(document.body.dataset.overlayOpen).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <>
        <Sut open={false} />
        <Sut open={false} />
      </>,
    );
    expect(document.body.dataset.overlayOpen).toBeUndefined();
    expect(document.body.style.overflow).toBe('');
  });

  it('limpa o marcador quando o modal desmonta sem passar por open=false', () => {
    const { unmount } = render(<Sut open />);
    expect(document.body.dataset.overlayOpen).toBe('true');
    unmount();
    expect(document.body.dataset.overlayOpen).toBeUndefined();
  });
});
