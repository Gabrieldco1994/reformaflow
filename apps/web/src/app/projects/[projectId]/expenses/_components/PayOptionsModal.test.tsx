import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PayOptionsModal } from './PayOptionsModal';

describe('PayOptionsModal', () => {
  it('mostra "Novo lançamento" e abre novo recebimento', async () => {
    const user = userEvent.setup();
    const onOpenNewReceiptForm = vi.fn();

    render(
      <PayOptionsModal
        open
        onClose={vi.fn()}
        onOpenNewPaidForm={vi.fn()}
        onOpenVoiceModal={vi.fn()}
        onOpenPlanForm={vi.fn()}
        onOpenRecorrenteForm={vi.fn()}
        onImportCard={vi.fn()}
        onImportAccount={vi.fn()}
        onOpenNewReceiptForm={onOpenNewReceiptForm}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Novo lançamento' })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Novo recebimento/i });
    await user.click(button);
    expect(onOpenNewReceiptForm).toHaveBeenCalledTimes(1);
  });
});
