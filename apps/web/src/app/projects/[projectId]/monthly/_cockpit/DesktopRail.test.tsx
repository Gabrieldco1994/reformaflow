import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopRail } from './DesktopRail';
import { useCopilotStore } from '@/stores/copilot-store';
import type { ComprometimentoMes } from './derive';

// Isola o contrato do rail do fluxo interno (queries/mutations) do launcher,
// já coberto pelos testes existentes de NovaDespesaLauncher/PayOptionsModal.
vi.mock('../../expenses/_components/NovaDespesaLauncher', () => ({
  NovaDespesaLauncher: ({ trigger }: { trigger: (open: () => void) => React.ReactNode }) =>
    trigger(() => {}),
}));

const COMPROMETIMENTO: ComprometimentoMes[] = [
  {
    mes: '2026-08',
    total: 150_000,
    itens: [
      { descricao: 'Notebook', parcela: '3/10', valor: 100_000, cardLast4: '1234' },
      { descricao: 'Celular', parcela: '1/6', valor: 50_000, cardLast4: '1234' },
    ],
  },
];

describe('DesktopRail', () => {
  it('renderiza o gatilho "Lançar agora" reusando o NovaDespesaLauncher', () => {
    render(<DesktopRail projectId="p1" projectType="PESSOAL" comprometimento={COMPROMETIMENTO} />);
    expect(screen.getByRole('button', { name: 'Lançar agora' })).toBeInTheDocument();
  });

  it('bloco Maria abre o Copiloto existente sem disparar nenhuma chamada de rede', () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    render(<DesktopRail projectId="p1" projectType="PESSOAL" comprometimento={[]} />);
    const cta = screen.getByRole('button', { name: /conversar com a maria/i });
    fireEvent.click(cta);
    // Abrir o painel é estado local (zustand) — nenhuma chamada de LLM/rede aqui.
    expect(useCopilotStore.getState().open).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lista os próximos vencimentos vindos do comprometimento futuro', () => {
    render(<DesktopRail projectId="p1" projectType="PESSOAL" comprometimento={COMPROMETIMENTO} />);
    expect(screen.getByText('Notebook')).toBeInTheDocument();
    expect(screen.getByText(/3\/10/)).toBeInTheDocument();
  });

  it('conjunto VAZIO de vencimentos mostra estado vazio explícito, não uma lista em branco', () => {
    render(<DesktopRail projectId="p1" projectType="PESSOAL" comprometimento={[]} />);
    expect(screen.getByText(/nenhum vencimento/i)).toBeInTheDocument();
  });
});
