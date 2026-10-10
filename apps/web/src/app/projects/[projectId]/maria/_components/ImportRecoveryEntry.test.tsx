import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportRecoveryEntry } from './ImportRecoveryEntry';

vi.mock('./ImportRecoveryPanel', () => ({
  ImportRecoveryPanel: () => <p>painel de retomada</p>,
}));

describe('ImportRecoveryEntry', () => {
  it('keeps the panel unmounted until opened, then closes back to the trigger', () => {
    render(<ImportRecoveryEntry />);
    const trigger = screen.getByRole('button', { name: 'Importações da Maria' });
    expect(screen.queryByText('painel de retomada')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Importações da Maria' })).toBeTruthy();
    expect(screen.getByText('painel de retomada')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /fechar/i }));
    expect(screen.queryByText('painel de retomada')).toBeNull();
  });

  it('remounts the panel on every open so nothing from a previous open is shown as fresh', () => {
    render(<ImportRecoveryEntry />);
    fireEvent.click(screen.getByRole('button', { name: 'Importações da Maria' }));
    fireEvent.click(screen.getByRole('button', { name: /fechar/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Importações da Maria' }));
    expect(screen.getByText('painel de retomada')).toBeTruthy();
  });
});
