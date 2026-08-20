import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KpiTile } from './KpiTile';

/**
 * #490 D-B — `<button>` dentro de `<button>`.
 *
 * O KPI clicável (quick-filter) embrulhava o rótulo inteiro num `<button>`, e o
 * rótulo carrega o gatilho de ajuda `InfoHint`, que também é `<button>`. HTML
 * inválido: o React derruba `Warning: In HTML, <button> cannot be a descendant
 * of <button>. This will cause a hydration error` em toda carga de `/conta` e
 * `/dre`, e o parser do navegador tem liberdade para fechar o botão externo
 * antes do interno — a árvore hidratada diverge da renderizada no servidor.
 *
 * Estrutura é o contrato aqui: geometria e pintura vivem no Playwright, porque
 * jsdom não tem layout.
 */
describe('KpiTile — dois controles, nenhum aninhado (#490)', () => {
  it('não aninha botão dentro de botão quando é clicável e tem ajuda', () => {
    const { container } = render(
      <KpiTile
        label="Saiu no mês"
        value="R$ 303,03"
        info="Tudo que já saiu da conta neste mês."
        onClick={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('button button')).toHaveLength(0);
  });

  it('mantém os dois controles utilizáveis: filtro e ajuda', () => {
    const onClick = vi.fn();
    render(
      <KpiTile
        label="Saiu no mês"
        value="R$ 303,03"
        info="Tudo que já saiu da conta neste mês."
        onClick={onClick}
      />,
    );

    // O card inteiro continua sendo o alvo do quick-filter, com nome acessível.
    const filtro = screen.getByRole('button', { name: /Saiu no mês/ });
    fireEvent.click(filtro);
    expect(onClick).toHaveBeenCalledTimes(1);

    // A ajuda é um controle próprio, irmão do filtro — não dispara o filtro.
    const ajuda = screen.getByRole('button', { name: 'Ajuda' });
    fireEvent.click(ajuda);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Tudo que já saiu da conta neste mês.',
    );
  });

  it('reflete o estado ativo do quick-filter em aria-pressed', () => {
    const { rerender } = render(
      <KpiTile label="Entrou no mês" value="R$ 1,00" info="ajuda" onClick={vi.fn()} active />,
    );
    expect(screen.getByRole('button', { name: /Entrou no mês/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    rerender(
      <KpiTile label="Entrou no mês" value="R$ 1,00" info="ajuda" onClick={vi.fn()} active={false} />,
    );
    expect(screen.getByRole('button', { name: /Entrou no mês/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('não gera botão nenhum quando o KPI não é clicável', () => {
    const { container } = render(
      <KpiTile label="Sobra prevista" value="R$ 606,06" info="ajuda" />,
    );
    // Só o gatilho de ajuda.
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Ajuda' })).toBeInTheDocument();
  });
});
