import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BankAccountFormModal from './BankAccountFormModal';

const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
  },
}));

function fillLast4() {
  fireEvent.change(screen.getAllByPlaceholderText('1234')[0], { target: { value: '1234' } });
}

describe('BankAccountFormModal hideCancel prop', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockResolvedValue({});
  });

  it('hideCancel=false (default): "Cancelar" button is present', () => {
    render(
      <BankAccountFormModal projectId="p1" account={null} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText('Cancelar')).toBeInTheDocument();
  });

  it('hideCancel=true: "Cancelar" button is absent, "Salvar" is still present and still calls onSaved on success', async () => {
    const onSaved = vi.fn();
    render(
      <BankAccountFormModal projectId="p1" account={null} onClose={vi.fn()} onSaved={onSaved} hideCancel />,
    );
    expect(screen.queryByText('Cancelar')).not.toBeInTheDocument();
    fillLast4();
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
