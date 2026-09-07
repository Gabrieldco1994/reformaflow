import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import ImportWithoutAccountModal from './ImportWithoutAccountModal';

/**
 * #659: o painel da jornada (`data-journey-panel`, z-[70]) só sai da frente
 * de um overlay de tela cheia quando `body[data-overlay-open]` está setado
 * (ver globals.css) — sinal que só existe enquanto o contador compartilhado
 * de `useOverlayLock` estiver > 0. Este modal nunca chamava o hook (só
 * `usePageInert`, que isola foco/hit-testing mas não escreve o atributo), e
 * ficava tapado pelo card da jornada por baixo dele.
 */

vi.mock('@/lib/api', () => ({
  api: { upload: vi.fn() },
}));

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  delete document.body.dataset.overlayOpen;
});

describe('#659 ImportWithoutAccountModal — useOverlayLock (RED)', () => {
  it('marca body[data-overlay-open] enquanto o modal está montado', () => {
    expect(document.body.dataset.overlayOpen).toBeUndefined();

    render(
      <ImportWithoutAccountModal
        projectId="p1"
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );

    expect(document.body.dataset.overlayOpen).toBe('true');
  });

  it('limpa o atributo quando o modal desmonta', () => {
    const { unmount } = render(
      <ImportWithoutAccountModal
        projectId="p1"
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );
    expect(document.body.dataset.overlayOpen).toBe('true');

    unmount();

    expect(document.body.dataset.overlayOpen).toBeUndefined();
  });

  it('não destrava cedo se outro overlay empilhado ainda estiver aberto (contador compartilhado)', () => {
    const { unmount: unmountA } = render(
      <ImportWithoutAccountModal
        projectId="p1"
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );
    const { unmount: unmountB } = render(
      <ImportWithoutAccountModal
        projectId="p1"
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );
    expect(document.body.dataset.overlayOpen).toBe('true');

    unmountA();
    expect(document.body.dataset.overlayOpen).toBe('true');

    unmountB();
    expect(document.body.dataset.overlayOpen).toBeUndefined();
  });
});
