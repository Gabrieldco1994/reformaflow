'use client';
import { ExpensesView } from './ExpensesView';

/**
 * Rota "Despesas" (eixo de competência / Gastos Controle). A Conta Real foi
 * separada para a rota dedicada `/conta` (Visão Conta) no menu lateral.
 */
export default function ExpensesPage() {
  return <ExpensesView lockedEixo="competencia" />;
}
