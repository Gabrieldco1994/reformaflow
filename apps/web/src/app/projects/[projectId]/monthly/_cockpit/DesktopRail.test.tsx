import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopRail } from './DesktopRail';
import { useCopilotStore } from '@/stores/copilot-store';

// Isola o contrato do rail do fluxo interno (queries/mutations) do launcher,
// já coberto pelos testes existentes de NovaDespesaLauncher/PayOptionsModal.
vi.mock('../../expenses/_components/NovaDespesaLauncher', () => ({
  NovaDespesaLauncher: ({ trigger }: { trigger: (open: () => void) => React.ReactNode }) =>
    trigger(() => {}),
}));

describe('DesktopRail', () => {
  it('renderiza o gatilho "Lançar agora" reusando o NovaDespesaLauncher', () => {
    render(<DesktopRail projectId="p1" projectType="PESSOAL" />);
    expect(screen.getByRole('button', { name: 'Lançar agora' })).toBeInTheDocument();
  });

  it('bloco Maria abre o Copiloto existente sem disparar nenhuma chamada de rede', () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    render(<DesktopRail projectId="p1" projectType="PESSOAL" />);
    const cta = screen.getByRole('button', { name: /conversar com a maria/i });
    fireEvent.click(cta);
    // Abrir o painel é estado local (zustand) — nenhuma chamada de LLM/rede aqui.
    expect(useCopilotStore.getState().open).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mantém lançar e maria no mesmo card de ações rápidas', () => {
    render(<DesktopRail projectId="p1" projectType="PESSOAL" />);
    expect(screen.getByText(/ações rápidas/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lançar agora' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /conversar com a maria/i })).toBeInTheDocument();
  });
});
