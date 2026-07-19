'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ReceiptFormData } from '@/types';

export interface ReceiptsPlanConfig {
  /** Salário mensal total, em reais. */
  salary: number;
  /** Percentual do salário pago no dia 15 (adiantamento), 0–100. */
  day15Pct: number;
  /** Quantos meses gerar (mínimo 1). */
  months: number;
  /** Mês inicial no formato 'YYYY-MM'. */
  startMonth: string;
  /** Dividendos mensais, em reais. */
  dividends: number;
  /** Juros de renda fixa mensais, em reais. */
  fixedIncome: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Data 'YYYY-MM-DD' com o dia limitado ao último dia do mês (clamp de mês). */
function safeDate(year: number, monthIndex: number, day: number): string {
  const monthLastDay = new Date(year, monthIndex + 1, 0).getDate();
  const safeDay = Math.min(day, monthLastDay);
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

/**
 * Monta os recebimentos PREVISTOS do plano pessoal (função pura, testável):
 * salário quebrado em adiantamento (dia 15) + fechamento (dia 30), mais
 * dividendos e juros de renda fixa mensais, por N meses a partir de startMonth.
 */
export function buildPlanPayloads(config: ReceiptsPlanConfig): ReceiptFormData[] {
  const salary = Math.max(0, config.salary || 0);
  const day15Pct = Math.max(0, Math.min(100, config.day15Pct || 0));
  const months = Math.max(1, Math.floor(config.months) || 1);
  const dividends = Math.max(0, config.dividends || 0);
  const fixedIncome = Math.max(0, config.fixedIncome || 0);
  if (salary <= 0 && dividends <= 0 && fixedIncome <= 0) return [];

  const [startY, startM] = config.startMonth.split('-').map(Number);
  if (!startY || !startM) return [];

  const payloads: ReceiptFormData[] = [];
  for (let i = 0; i < months; i++) {
    const monthIndexAbsolute = startM - 1 + i;
    const year = startY + Math.floor(monthIndexAbsolute / 12);
    const monthIndex = monthIndexAbsolute % 12;

    if (salary > 0) {
      const adiantamento = round2(salary * (day15Pct / 100));
      const fechamento = round2(salary - adiantamento);
      if (adiantamento > 0) {
        payloads.push({
          valor: adiantamento,
          data: safeDate(year, monthIndex, 15),
          tipo: 'ADIANTAMENTO_SALARIO',
          status: 'PREVISTO',
        });
      }
      if (fechamento > 0) {
        payloads.push({
          valor: fechamento,
          data: safeDate(year, monthIndex, 30),
          tipo: 'SALARIO',
          status: 'PREVISTO',
        });
      }
    }
    if (dividends > 0) {
      payloads.push({
        valor: dividends,
        data: safeDate(year, monthIndex, 30),
        tipo: 'DIVIDENDOS',
        status: 'PREVISTO',
      });
    }
    if (fixedIncome > 0) {
      payloads.push({
        valor: fixedIncome,
        data: safeDate(year, monthIndex, 30),
        tipo: 'JUROS_RENDA_FIXA',
        status: 'PREVISTO',
      });
    }
  }
  return payloads;
}

export interface GeneratePlanResult {
  ok: number;
  total: number;
  failures: number;
}

/** Cria os recebimentos do plano em sequência, com progresso e invalidação. */
export function useGenerateReceiptsPlan(projectId: string) {
  const queryClient = useQueryClient();
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function generate(config: ReceiptsPlanConfig): Promise<GeneratePlanResult> {
    const payloads = buildPlanPayloads(config);
    if (payloads.length === 0) return { ok: 0, total: 0, failures: 0 };

    setIsGenerating(true);
    setProgress({ done: 0, total: payloads.length });
    let ok = 0;
    let failures = 0;
    try {
      for (const p of payloads) {
        try {
          await api.post(`/projects/${projectId}/receipts`, p);
          ok += 1;
        } catch {
          failures += 1;
        }
        setProgress({ done: ok + failures, total: payloads.length });
      }
      for (const key of ['account-view', 'expenses', 'receipts', 'cash-flow', 'dashboard']) {
        queryClient.invalidateQueries({ queryKey: [key, projectId] });
      }
      return { ok, total: payloads.length, failures };
    } finally {
      setIsGenerating(false);
      setProgress(null);
    }
  }

  return { generate, isGenerating, progress };
}
