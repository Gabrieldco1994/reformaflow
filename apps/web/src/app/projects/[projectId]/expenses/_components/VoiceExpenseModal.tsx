import { Mic } from 'lucide-react';
import { ExpenseType, PaymentForm, type ExpenseStatus } from '@reformaflow/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';

interface ExpenseOption {
  value: string;
  label: string;
}

export interface VoiceExpenseData {
  tipoDespesa: ExpenseType;
  titulo: string;
  valor: number | null;
  formaPagamento: PaymentForm;
  quantidadeParcela: number | null;
  status: ExpenseStatus;
  dataReferencia: string;
}

interface VoiceExpenseModalProps {
  open: boolean;
  onClose: () => void;
  voiceSupported: boolean;
  voiceListening: boolean;
  voiceTranscript: string;
  voiceError: string;
  voiceData: VoiceExpenseData | null;
  setVoiceData: (data: VoiceExpenseData) => void;
  voiceFornecedor: string;
  setVoiceFornecedor: (value: string) => void;
  startVoiceCapture: () => void;
  clearVoiceTranscript: () => void;
  saveVoiceExpense: () => void;
  saveDisabled: boolean;
  tipoDespesaOptions: ExpenseOption[];
}

export function VoiceExpenseModal({
  open,
  onClose,
  voiceSupported,
  voiceListening,
  voiceTranscript,
  voiceError,
  voiceData,
  setVoiceData,
  voiceFornecedor,
  setVoiceFornecedor,
  startVoiceCapture,
  clearVoiceTranscript,
  saveVoiceExpense,
  saveDisabled,
  tipoDespesaOptions,
}: VoiceExpenseModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Lançar despesa por voz">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Fale uma frase como: <span className="font-medium">&quot;Gastei 85 reais no mercado no cartão hoje&quot;</span>.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={startVoiceCapture}
            disabled={!voiceSupported || voiceListening}
          >
            <Mic className="w-4 h-4" /> {voiceListening ? 'Ouvindo...' : 'Capturar voz'}
          </Button>
          {voiceTranscript && (
            <Button type="button" variant="secondary" onClick={clearVoiceTranscript}>
              Limpar
            </Button>
          )}
        </div>

        {!voiceSupported && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            Seu navegador não suporta reconhecimento de voz. Use o lançamento manual.
          </p>
        )}

        {voiceTranscript && (
          <div className="rounded border bg-gray-50 px-3 py-2">
            <p className="text-xs text-gray-500 mb-1">Transcrição</p>
            <p className="text-sm text-gray-800">{voiceTranscript}</p>
          </div>
        )}

        {voiceError && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {voiceError}
          </p>
        )}

        {voiceData && (
          <div className="space-y-3 rounded border p-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Revisar antes de salvar</p>
            <Select
              label="Tipo da Despesa"
              name="voiceTipoDespesa"
              options={tipoDespesaOptions}
              value={voiceData.tipoDespesa}
              onChange={(e) => setVoiceData({ ...voiceData, tipoDespesa: e.target.value as ExpenseType })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Valor (R$)"
                name="voiceValor"
                type="number"
                step="0.01"
                min="0"
                value={voiceData.valor ? String(voiceData.valor) : ''}
                onChange={(e) =>
                  setVoiceData({
                    ...voiceData,
                    valor: e.target.value ? Number.parseFloat(e.target.value) : null,
                  })
                }
              />
              <Select
                label="Forma de Pagamento"
                name="voiceFormaPagamento"
                options={FORMA_PAGAMENTO_OPTIONS}
                value={voiceData.formaPagamento}
                onChange={(e) =>
                  setVoiceData({
                    ...voiceData,
                    formaPagamento: e.target.value as PaymentForm,
                    quantidadeParcela:
                      e.target.value === PaymentForm.A_VISTA ? null : (voiceData.quantidadeParcela ?? 1),
                  })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Status"
                name="voiceStatus"
                options={[
                  { value: 'PLANEJADO', label: 'Planejado' },
                  { value: 'PAGO', label: 'Pago' },
                ]}
                value={voiceData.status}
                onChange={(e) => setVoiceData({ ...voiceData, status: e.target.value as ExpenseStatus })}
              />
              {voiceData.formaPagamento === PaymentForm.A_VISTA ? (
                <Input
                  label="Data do Pagamento"
                  name="voiceDataPagamento"
                  type="date"
                  value={voiceData.dataReferencia}
                  onChange={(e) => setVoiceData({ ...voiceData, dataReferencia: e.target.value })}
                />
              ) : (
                <Input
                  label="Qtd Parcelas"
                  name="voiceQuantidadeParcela"
                  type="number"
                  min="1"
                  value={String(voiceData.quantidadeParcela ?? 1)}
                  onChange={(e) =>
                    setVoiceData({
                      ...voiceData,
                      quantidadeParcela: Math.max(1, Number.parseInt(e.target.value || '1', 10)),
                    })
                  }
                />
              )}
            </div>
            {voiceData.formaPagamento !== PaymentForm.A_VISTA && (
              <Input
                label="Data de Início"
                name="voiceDataInicioParcela"
                type="date"
                value={voiceData.dataReferencia}
                onChange={(e) => setVoiceData({ ...voiceData, dataReferencia: e.target.value })}
              />
            )}
            <Input
              label="Título"
              name="voiceTitulo"
              value={voiceData.titulo}
              onChange={(e) => setVoiceData({ ...voiceData, titulo: e.target.value })}
            />
            <Input
              label="Fornecedor"
              name="voiceFornecedor"
              value={voiceFornecedor}
              onChange={(e) => setVoiceFornecedor(e.target.value)}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={saveVoiceExpense} disabled={saveDisabled}>
            Salvar despesa
          </Button>
        </div>
      </div>
    </Modal>
  );
}
