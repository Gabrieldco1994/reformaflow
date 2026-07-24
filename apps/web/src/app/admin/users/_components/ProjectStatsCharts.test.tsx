import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectStatsCharts, type ProjectStats } from './ProjectStatsCharts';

const stats: ProjectStats = {
  byType: [],
  contentTodayByType: [],
  contentTodayTotal: 0,
  expensesByType: [{ type: 'PESSOAL', count: 8, users: [] }],
  expensesTotal: 8,
  expensesTodayByType: [{ type: 'CASA', count: 2, users: [] }],
  expensesTodayTotal: 2,
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-01-02T00:00:00.000Z',
};

describe('ProjectStatsCharts - filtro Hoje/Sempre em Despesas por tipo', () => {
  it('mostra "Sempre" por padrão e alterna para "Hoje" ao clicar', () => {
    render(<ProjectStatsCharts stats={stats} />);

    expect(screen.getByText('8 despesas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    expect(screen.getByText('2 despesas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sempre' }));
    expect(screen.getByText('8 despesas')).toBeInTheDocument();
  });
});
