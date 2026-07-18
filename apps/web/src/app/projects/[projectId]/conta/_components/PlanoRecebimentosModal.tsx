'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { currencyInputToNumber, maskCurrencyInput } from '@/lib/currency-input';
import { useGenerateReceiptsPlan } from '../_hooks/useGenerateReceiptsPlan';

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function PlanoRecebimentosModal({
  open,
  onClose,
  projectId,
  defaultMonth,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  defaultMonth?: string;
}) {
  const [salaryValue, setSalaryValue] = useState('');
  const [salaryDay15Pct, setSalaryDay15Pct] = useState('40');
  const [monthsToGenerate, setMonthsToGenerate] = useState('12');
  const [startMonth, setStartMonth] = useState(defaultMonth || currentMonth());
  const [dividendsValue, setDividendsValue] = useState('');
  const [fixedIncomeValue, setFixedIncomeValue] = useState('');

  const { generate, isGenerating, progress } = useGenerateReceiptsPlan(projectId);

  async function handleGenerate() {
    const result = await generate({
      salary: currencyInputToNumber(salaryValue) || 0,
      day15Pct: Number(salaryDay15Pct) || 0,
      months: Number(monthsToGenerate) || 1,
      startMonth,
      dividends: currencyInputToNumber(dividendsValue) || 0,
      fixedIncome: currencyInputToNumber(fixedIncomeValue) || 0,
    });

    if (result.total === 0) {
      toast.error('Informe ao menos salário, dividendos ou juros de renda fixa.');
      return;
    }
    if (result.failures > 0) {
      toast.error(`Criados ${result.ok} de ${result.total}. ${result.failures} falharam — tente gerar os restantes.`);
      return;
    }
    toast.success(`${result.ok} recebimento${result.ok === 1 ? '' : 's'} previsto${result.ok === 1 ? '' : 's'} gerado${result.ok === 1 ? '' : 's'}.`);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Planejar recebimentos" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-lifeone-ink-3">
          Gera recebimentos <strong>previstos</strong> em série: salário quebrado em
          adiantamento (dia 15) e fechamento (dia 30), mais dividendos e juros de renda fixa.
        </p>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Input
            label="Salário mensal total (R$)"
            type="text"
            inputMode="numeric"
            value={salaryValue}
            onChange={(e) => setSalaryValue(maskCurrencyInput(e.target.value))}
          />
          <Input
            label="% no dia 15"
            type="number"
            min="0"
            max="100"
            value={salaryDay15Pct}
            onChange={(e) => setSalaryDay15Pct(e.target.value)}
          />
          <Input
            label="Meses para gerar"
            type="number"
            min="1"
            max="24"
            value={monthsToGenerate}
            onChange={(e) => setMonthsToGenerate(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Input
            label="Mês inicial"
            type="month"
            value={startMonth}
            onChange={(e) => setStartMonth(e.target.value)}
          />
          <Input
            label="Dividendos mensais (R$)"
            type="text"
            inputMode="numeric"
            value={dividendsValue}
            onChange={(e) => setDividendsValue(maskCurrencyInput(e.target.value))}
          />
          <Input
            label="Juros renda fixa mensal (R$)"
            type="text"
            inputMode="numeric"
            value={fixedIncomeValue}
            onChange={(e) => setFixedIncomeValue(maskCurrencyInput(e.target.value))}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isGenerating}>
            Cancelar
          </Button>
          <Button onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {progress ? `Gerando ${progress.done}/${progress.total}...` : 'Gerando...'}
              </>
            ) : (
              'Gerar recebimentos (15/30)'
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
