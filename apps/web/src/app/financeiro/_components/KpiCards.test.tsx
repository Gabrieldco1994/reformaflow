import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { InfoHint } from '@/components/InfoHint';
import { KpiCards } from './KpiCards';

const overview = {
  caixaTotal: 10000,
  pagoTotal: 2000,
  pagoMesAtual: 2000,
  previsao30d: 3000,
  previsao90d: 3000,
  recebimento30d: 0,
  recebimento90d: 0,
  saldoProjetado30d: 11000,
  pagoYTD: 9000,
  saldoProjetado90d: 12000,
  totalProjetos: 1,
};

const glossary = [
  ['Caixa', 'dinheiro disponível hoje nas contas, considerando saldo inicial e movimentações realizadas.'],
  ['Resultado', 'diferença entre o que entrou e o que saiu no período; não representa sozinho o saldo bancário.'],
  ['Projeção', 'estimativa de fechamento: caixa atual + valores a receber − valores ainda a pagar.'],
] as const;

describe('financial glossary', () => {
  it("preserves InfoHint's default accessible name", () => {
    render(<InfoHint text="Texto de ajuda" />);
    expect(screen.getByRole('button', { name: 'Ajuda' })).toBeInTheDocument();
  });

  it.each(glossary)('explains %s from its keyboard-accessible trigger', async (term, definition) => {
    const user = userEvent.setup();
    render(<KpiCards data={overview} />);
    expect(screen.getAllByText(term).length).toBeGreaterThan(0);
    const trigger = screen.getAllByRole('button', { name: `Saiba mais sobre ${term}` })[0];
    fireEvent.focus(trigger);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(definition);
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });
});
