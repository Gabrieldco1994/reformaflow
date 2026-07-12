import { describe, it, expect } from 'vitest';
import { faturaDestino } from './fatura-destino';

describe('faturaDestino', () => {
  it('retorna null quando closingDay é null (cartão sem fechamento)', () => {
    expect(faturaDestino(new Date('2025-07-10'), null, null)).toBeNull();
  });

  it('dia < closingDay → fatura no mês atual', () => {
    // compra dia 4, fecha dia 5 → fica em julho
    const r = faturaDestino(new Date('2025-07-04'), 5, 12);
    expect(r).not.toBeNull();
    expect(r!.fecha).toBe('5 jul');
    expect(r!.vence).toBe('12 jul');
  });

  it('dia == closingDay → fatura no mês seguinte', () => {
    // compra dia 5, fecha dia 5 → vai para agosto
    const r = faturaDestino(new Date('2025-07-05'), 5, 12);
    expect(r).not.toBeNull();
    expect(r!.fecha).toBe('5 ago');
    expect(r!.vence).toBe('12 ago');
  });

  it('dia > closingDay → fatura no mês seguinte', () => {
    // compra dia 10, fecha dia 5 → vai para agosto
    const r = faturaDestino(new Date('2025-07-10'), 5, 12);
    expect(r).not.toBeNull();
    expect(r!.fecha).toBe('5 ago');
    expect(r!.vence).toBe('12 ago');
  });

  it('virada de ano: compra em dezembro após fechamento → fatura em janeiro do ano seguinte', () => {
    const r = faturaDestino(new Date('2025-12-20'), 5, 15);
    expect(r).not.toBeNull();
    expect(r!.fecha).toBe('5 jan');
    expect(r!.vence).toBe('15 jan');
    expect(r!.mesLabel).toContain('2026');
  });

  it('não inventa vencimento quando dueDay é null', () => {
    const r = faturaDestino(new Date('2025-07-04'), 5, null);
    expect(r).not.toBeNull();
    expect(r!.vence).toBe('—');
  });
});
