import type { ComponentProps } from 'react';
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

/**
 * #218 (W5) — contrato do botão "Extrato bancário".
 *
 * O `PayOptionsModal` já renderiza a oferta de import de extrato condicionada a
 * `onImportAccount` (`{onImportAccount && ...}`). Estes casos TRAVAM esse
 * contrato: o gate `hasFeature('bankAccounts') && hasModule('bankAccounts')`
 * dos consumidores (`ExpensesView`, `NovaDespesaLauncher`, `MobileLaunchSheetContainer`)
 * passa `undefined` quando falha, e o botão TEM de sumir — nunca virar um clique
 * que leva a `GET /projects/:id/bank-accounts` → 403 (o dead-end do #656).
 *
 * "Fatura de cartão" (`onImportCard`) é independente: creditCards é autorizado
 * em REFORMA/COMPRA, então esse caminho não regride.
 */
describe('PayOptionsModal — oferta de import de extrato (#218)', () => {
  function renderModal(overrides: Partial<ComponentProps<typeof PayOptionsModal>> = {}) {
    return render(
      <PayOptionsModal
        open
        onClose={vi.fn()}
        onOpenNewPaidForm={vi.fn()}
        onOpenVoiceModal={vi.fn()}
        onImportCard={vi.fn()}
        {...overrides}
      />,
    );
  }

  it('SEM onImportAccount → nenhum botão "Extrato bancário"', () => {
    renderModal({ onImportAccount: undefined });
    expect(
      screen.queryByRole('button', { name: /Extrato bancário/i }),
    ).not.toBeInTheDocument();
  });

  it('SEM onImportAccount → "Fatura de cartão" continua presente (não regride)', () => {
    renderModal({ onImportAccount: undefined });
    expect(
      screen.getByRole('button', { name: /Fatura de cartão/i }),
    ).toBeInTheDocument();
  });

  it('COM onImportAccount → botão presente e o clique dispara o callback 1×', async () => {
    const user = userEvent.setup();
    const onImportAccount = vi.fn();
    renderModal({ onImportAccount });

    const botao = screen.getByRole('button', { name: /Extrato bancário/i });
    await user.click(botao);
    expect(onImportAccount).toHaveBeenCalledTimes(1);
  });
});
