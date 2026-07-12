import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReminderKpiHero } from './ReminderKpiHero';
import type { ReminderRow } from './ReminderCard';

const reminder: ReminderRow = {
  id: '1',
  titulo: 'Trocar filtro',
  data: '2026-08-01',
  recorrencia: 'UNICA',
  status: 'PENDENTE',
  prioridade: 'ALTA',
};

describe('ReminderKpiHero', () => {
  it('shows the next reminder title/date as hero and pending count as support', () => {
    render(<ReminderKpiHero nextReminder={reminder} pendingCount={2} overdueCount={0} />);

    const hero = screen.getByRole('article', { name: 'Próximo lembrete' });
    expect(hero).toHaveTextContent('Trocar filtro');

    const pending = screen.getByRole('article', { name: 'Pendentes' });
    expect(pending).toHaveTextContent('2');
    expect(pending).toHaveTextContent('em dia');
  });

  it('surfaces overdue count in the support tile without hiding the hero', () => {
    render(<ReminderKpiHero nextReminder={reminder} pendingCount={2} overdueCount={1} />);

    expect(screen.getByRole('article', { name: 'Pendentes' })).toHaveTextContent('1 atrasado(s)');
  });

  it('empty state: no pending reminder renders a message, not a crash', () => {
    render(<ReminderKpiHero nextReminder={null} pendingCount={0} overdueCount={0} />);

    expect(screen.getByRole('article', { name: 'Próximo lembrete' })).toHaveTextContent(
      'Nenhum lembrete pendente',
    );
    expect(screen.getByRole('article', { name: 'Pendentes' })).toHaveTextContent('0');
  });
});
