import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReminderCard, type ReminderRow } from './ReminderCard';

/**
 * Issue #585 (continuação) — `Reminder` passou a trazer `plant: { id, nome } | null`
 * (vínculo opcional com uma planta, gerado por PLANTAS). O card deve mostrar
 * "Planta: <nome>" quando presente e não renderizar nada (nem placeholder) quando
 * o lembrete não tem planta vinculada.
 */

const baseReminder: ReminderRow = {
  id: 'reminder-1',
  titulo: 'Regar orquídea',
  data: '2099-01-31T00:00:00.000Z',
  recorrencia: 'SEMANAL',
  status: 'PENDENTE',
  prioridade: 'MEDIA',
};

const noop = () => {};

describe('ReminderCard — vínculo com planta', () => {
  it('mostra "Planta: <nome>" quando o lembrete tem planta vinculada', () => {
    const reminder: ReminderRow = { ...baseReminder, plant: { id: 'plant-1', nome: 'Orquídea da sala' } };
    render(
      <ReminderCard reminder={reminder} onMarkDone={noop} onPostpone={noop} onEdit={noop} onDelete={vi.fn()} />
    );

    expect(screen.getByText('Planta: Orquídea da sala')).toBeInTheDocument();
  });

  it('não mostra nada de planta quando o lembrete não tem planta vinculada (plant undefined)', () => {
    render(
      <ReminderCard reminder={baseReminder} onMarkDone={noop} onPostpone={noop} onEdit={noop} onDelete={vi.fn()} />
    );

    expect(screen.queryByText(/^Planta:/)).not.toBeInTheDocument();
  });

  it('não mostra nada de planta quando plant é null', () => {
    const reminder: ReminderRow = { ...baseReminder, plant: null };
    render(
      <ReminderCard reminder={reminder} onMarkDone={noop} onPostpone={noop} onEdit={noop} onDelete={vi.fn()} />
    );

    expect(screen.queryByText(/^Planta:/)).not.toBeInTheDocument();
  });
});
