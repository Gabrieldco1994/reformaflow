'use client';
import { ExpensesView } from '../expenses/ExpensesView';

/**
 * Rota "Visão Conta" (eixo de caixa / Conta Real) do PESSOAL. Reusa o mesmo
 * componente de despesas travado em `eixo='caixa'`, sem o toggle — separando a
 * Conta Real como item próprio do menu lateral.
 */
export default function ContaPage() {
  return <ExpensesView lockedEixo="caixa" />;
}
