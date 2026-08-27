import { fireEvent, render, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './modal';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  delete document.body.dataset.overlayOpen;
});

describe('Modal — Escape', () => {
  it('fecha com Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Teste">
        <p>conteúdo</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('o X de fechar é alvo de toque ≥44px e chama onClose (#569)', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Teste">
        <p>conteúdo</p>
      </Modal>,
    );

    const closeBtn = screen.getByRole('button', { name: 'Fechar' });
    // jsdom não faz layout — o piso de 44px é garantido pelas classes utilitárias.
    expect(closeBtn.className).toMatch(/\bmin-h-11\b/);
    expect(closeBtn.className).toMatch(/\bmin-w-11\b/);

    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('não chama onClose quando fechado', () => {
    const onClose = vi.fn();
    render(
      <Modal open={false} onClose={onClose} title="Teste">
        <p>conteúdo</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  // Modais aninhados (ex.: ExpenseFormModal > "Criar despesa em outro
  // projeto", renderizado via portal=true): abrir o modal externo primeiro e
  // o interno depois (fluxo real de clique do usuário) — Escape deve fechar
  // SÓ o de cima. Sem a checagem de topo-de-pilha, os dois listeners de
  // `document` disparam na mesma tecla e ambos fecham.
  it('com modais empilhados, Escape fecha apenas o topo (o mais recente aberto)', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();

    const { rerender } = render(
      <Modal open onClose={onCloseOuter} title="Externo">
        <Modal open={false} onClose={onCloseInner} title="Interno" portal>
          <p>aninhado</p>
        </Modal>
      </Modal>,
    );

    // usuário clica em algo dentro do externo e abre o interno por cima
    rerender(
      <Modal open onClose={onCloseOuter} title="Externo">
        <Modal open onClose={onCloseInner} title="Interno" portal>
          <p>aninhado</p>
        </Modal>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  it('após o modal do topo fechar, Escape volta a afetar o modal de baixo', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();

    const { rerender } = render(
      <Modal open onClose={onCloseOuter} title="Externo">
        <Modal open={false} onClose={onCloseInner} title="Interno" portal>
          <p>aninhado</p>
        </Modal>
      </Modal>,
    );

    rerender(
      <Modal open onClose={onCloseOuter} title="Externo">
        <Modal open onClose={onCloseInner} title="Interno" portal>
          <p>aninhado</p>
        </Modal>
      </Modal>,
    );

    rerender(
      <Modal open onClose={onCloseOuter} title="Externo">
        <Modal open={false} onClose={onCloseInner} title="Interno" portal>
          <p>aninhado</p>
        </Modal>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCloseOuter).toHaveBeenCalledTimes(1);
    expect(onCloseInner).not.toHaveBeenCalled();
  });
});
