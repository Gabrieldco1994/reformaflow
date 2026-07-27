import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectStatsCharts, type ProjectStats } from './ProjectStatsCharts';

describe('ProjectStatsCharts', () => {
  const mockStats: ProjectStats = {
    byType: [
      { type: 'PESSOAL', count: 5 },
      { type: 'REFORMA', count: 3 },
    ],
    contentTodayByType: [
      { type: 'PESSOAL', count: 2 },
      { type: 'REFORMA', count: 1 },
    ],
    contentTodayTotal: 3,
    windowStart: '2024-01-01',
    windowEnd: '2024-01-02',
  };

  it('renders without error when stats has data', () => {
    render(<ProjectStatsCharts stats={mockStats} />);
    expect(screen.getByText(/Projetos por tipo/i)).toBeInTheDocument();
  });

  it('renders both charts (PieChart and BarChart)', () => {
    render(<ProjectStatsCharts stats={mockStats} />);

    // Both chart containers should be present
    expect(screen.getByText(/Projetos por tipo/i)).toBeInTheDocument();
    expect(screen.getByText(/Criaram conteúdo hoje/i)).toBeInTheDocument();
  });

  it('exports ProjectStats interface', () => {
    // Type checking test - if this compiles, the interface is exported correctly
    const _testStats: ProjectStats = mockStats;
    expect(_testStats).toBeDefined();
  });

  it('displays project type labels', () => {
    render(<ProjectStatsCharts stats={mockStats} />);

    // Labels should be displayed in the legend
    expect(screen.getByText(/Pessoal/i)).toBeInTheDocument();
    expect(screen.getByText(/Reforma/i)).toBeInTheDocument();
  });

  it('displays total project count', () => {
    render(<ProjectStatsCharts stats={mockStats} />);

    // Should show "8 ativos" (5 + 3)
    const totalText = screen.getByText(/8 ativos/i);
    expect(totalText).toBeInTheDocument();
  });

  it('handles empty byType array', () => {
    const emptyStats: ProjectStats = {
      byType: [],
      contentTodayByType: [],
      contentTodayTotal: 0,
      windowStart: '2024-01-01',
      windowEnd: '2024-01-02',
    };

    render(<ProjectStatsCharts stats={emptyStats} />);

    expect(screen.getByText(/Sem projetos/i)).toBeInTheDocument();
  });

  it('handles empty contentTodayByType array', () => {
    const statsNothingToday: ProjectStats = {
      byType: [
        { type: 'PESSOAL', count: 5 },
      ],
      contentTodayByType: [],
      contentTodayTotal: 0,
      windowStart: '2024-01-01',
      windowEnd: '2024-01-02',
    };

    render(<ProjectStatsCharts stats={statsNothingToday} />);

    expect(screen.getByText(/Nenhum projeto criou conteúdo hoje/i)).toBeInTheDocument();
  });
});
