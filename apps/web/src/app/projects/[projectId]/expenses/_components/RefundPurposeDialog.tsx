'use client';

import { useEffect, useRef, useState } from 'react';
import type { RefundPurposeSummary } from '@reformaflow/domain';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { useAuth } from '@/contexts/auth-context';
import { tipoLabel } from '@/lib/expense-options';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import {
  REFUND_PURPOSE_COPY,
  useRefundPurpose,
  type RefundPurposeResult,
  type TargetProjectView,
} from '../_hooks/useRefundPurpose';

export const REFUND_PURPOSE_TITLE = 'Finalidade do crédito';

const RESULT_COPY: Record<RefundPurposeResult, string> = {
  applied: 'Finalidade confirmada.',
  'already-applied': 'Esta finalidade já estava confirmada.',
  undone: 'Finalidade desfeita.',
  'already-undone': 'Esta finalidade já estava desfeita.',
};

const fieldClass =
  'min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-60';
const alertClass = 'rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700';

interface TargetProps {
  /** Project of the screen the user is on (its views refresh after a write). */
  anchorProjectId: string;
  /** Project that REALLY owns the credit. */
  ownerProjectId: string;
  /** Real expense id, never a composite occurrence key. */
  expenseId: string;
}

interface DialogProps extends TargetProps {
  open: boolean;
  onClose: () => void;
}

/** The credit-purpose flow as its own dialog; the caller keeps whatever it had open underneath. */
export function RefundPurposeDialog({ open, onClose, ...target }: DialogProps) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={REFUND_PURPOSE_TITLE} trapFocus portal zIndex="z-[70]" closeDisabled={busy}>
      {/* Keyed by actor + credit: nothing read for another session or expense can leak in. */}
      <RefundPurposeView key={`${user?.id ?? 'anon'}|${target.ownerProjectId}|${target.expenseId}`} {...target} onDone={onClose} onBusyChange={setBusy} />
    </Modal>
  );
}

/** Destination and room come from the destination's own detail; never omitted, never a silent default. */
function destinationRows(summary: RefundPurposeSummary, target: TargetProjectView): Array<{ label: string; value: string }> {
  const { targetLoading, targetFailed, roomFailed, roomUnavailable, noRoom } = REFUND_PURPOSE_COPY;
  const name = target.status === 'ready' ? target.project.name : target.status === 'error' ? targetFailed : targetLoading;
  let room: string;
  if (summary.roomId === null) room = noRoom;
  else if (target.status === 'ready') {
    const found = target.project.rooms.find((r) => r.id === summary.roomId);
    room = found && found.deletedAt === null ? found.name : roomUnavailable;
  } else room = target.status === 'error' ? roomFailed : targetLoading;
  return [
    { label: 'Projeto de destino', value: name },
    { label: 'Ambiente', value: room },
  ];
}

function SummaryList({ summary, target }: { summary: RefundPurposeSummary; target: TargetProjectView }) {
  const rows: Array<{ label: string; value: string | null | undefined; money?: boolean }> = [
    ...destinationRows(summary, target),
    { label: 'Tipo da despesa', value: tipoLabel(summary.tipoDespesa) },
    { label: 'Valor', value: formatCurrency(summary.allocationCents / 100), money: true },
    { label: 'Data da compra', value: summary.dataCompra ? formatDateBR(summary.dataCompra) : null },
    { label: 'Data do pagamento', value: formatDateBR(summary.dataPagamento) },
    { label: 'Data no caixa', value: formatDateBR(summary.cashFlowDate) },
  ];
  return (
    <dl className="space-y-2 rounded-lg border border-darc-linen p-3 text-sm">
      {rows.map(
        (row) =>
          row.value != null && (
            <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <dt className="text-darc-velvet/70">{row.label}</dt>
              <dd className={`text-right font-medium text-darc-velvet ${row.money ? 'whitespace-nowrap tabular-nums' : ''}`}>{row.value}</dd>
            </div>
          ),
      )}
    </dl>
  );
}

function SummaryWithRetry({ summary, target }: { summary: RefundPurposeSummary; target: TargetProjectView }) {
  return (
    <div className="space-y-2">
      <SummaryList summary={summary} target={target} />
      {target.status === 'error' && (
        <Button type="button" variant="secondary" className="min-h-11" onClick={target.reload}>
          Recarregar destino
        </Button>
      )}
    </div>
  );
}

function RefundPurposeView({
  anchorProjectId,
  ownerProjectId,
  expenseId,
  onDone,
  onBusyChange,
}: TargetProps & { onDone: () => void; onBusyChange: (busy: boolean) => void }) {
  const p = useRefundPurpose({ anchorProjectId, ownerProjectId, expenseId, onBusyChange });
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    if (p.confirmingUndo) cancelRef.current?.focus();
  }, [p.confirmingUndo]);

  const assignment = p.state?.assignment ?? null;
  const showPrepare = !!p.state && p.state.actions.includes('PREPARE');
  const activeRooms = p.selectedTarget.status === 'ready' ? p.selectedTarget.project.rooms.filter((room) => room.deletedAt === null) : [];
  const working = p.busy !== null;

  return (
    <div className="space-y-4 text-darc-velvet">
      {p.result && (
        <div role="status" className="space-y-3 rounded-lg border border-darc-linen p-3 text-sm">
          <p className="font-medium">{RESULT_COPY[p.result]}</p>
          <Button type="button" className="min-h-11" onClick={onDone}>
            Concluir
          </Button>
        </div>
      )}
      {p.notice && (
        <p role="alert" className={alertClass}>
          {p.notice === 'lost-apply' ? REFUND_PURPOSE_COPY.lostApply : REFUND_PURPOSE_COPY.lostUndo}
        </p>
      )}
      {p.problem && (
        <p role="alert" className={alertClass}>
          {p.problem.kind === 'conflict' ? REFUND_PURPOSE_COPY.conflict : p.problem.text}
        </p>
      )}

      {p.loading ? (
        <p role="status" className="text-sm text-darc-velvet/70">
          Consultando finalidade…
        </p>
      ) : p.readFailed ? (
        <div className="space-y-3">
          <p role="alert" className={alertClass}>
            {REFUND_PURPOSE_COPY.consultFailed}
          </p>
          <Button type="button" variant="secondary" className="min-h-11" onClick={() => void p.reread()}>
            Consultar novamente
          </Button>
        </div>
      ) : p.stale || !p.state ? (
        <Button type="button" variant="secondary" className="min-h-11" onClick={() => void p.reread()}>
          Consultar novamente
        </Button>
      ) : (
        <>
          {assignment && <SummaryWithRetry summary={assignment.summary} target={p.assignmentTarget} />}

          {showPrepare && (
            <div className="space-y-3">
              <p className="text-sm text-darc-velvet/70">Escolha o projeto de destino e, se houver, o ambiente.</p>
              {p.catalogFailed && (
                <div className="space-y-2">
                  <p role="alert" className={alertClass}>
                    {REFUND_PURPOSE_COPY.catalogFailed}
                  </p>
                  <Button type="button" variant="secondary" className="min-h-11" onClick={p.reloadCatalog}>
                    Recarregar projetos
                  </Button>
                </div>
              )}
              {!p.catalogFailed && !p.catalogLoading && p.destinations.length === 0 && (
                <p className="text-sm text-darc-velvet/70">Não há projetos de destino disponíveis para este crédito.</p>
              )}
              <div className="space-y-1">
                <label htmlFor="refund-purpose-project" className="block text-sm font-medium text-gray-700">
                  Projeto de destino
                </label>
                <select
                  id="refund-purpose-project"
                  className={fieldClass}
                  value={p.selection.projectId}
                  disabled={working || p.catalogFailed}
                  onChange={(event) => p.selectProject(event.target.value)}
                >
                  <option value="">Selecione…</option>
                  {p.destinations.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="refund-purpose-room" className="block text-sm font-medium text-gray-700">
                  Ambiente
                </label>
                <select
                  id="refund-purpose-room"
                  className={fieldClass}
                  value={p.selection.roomId}
                  disabled={working || p.catalogFailed || p.selectedTarget.status !== 'ready'}
                  onChange={(event) => p.selectRoom(event.target.value)}
                >
                  <option value="">Sem ambiente</option>
                  {activeRooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name}
                    </option>
                  ))}
                </select>
                {p.selectedTarget.status === 'loading' && (
                  <p role="status" className="text-sm text-darc-velvet/70">
                    {REFUND_PURPOSE_COPY.roomsLoading}
                  </p>
                )}
              </div>
              {p.selectedTarget.status === 'error' && (
                <div className="space-y-2">
                  <p role="alert" className={alertClass}>
                    {REFUND_PURPOSE_COPY.roomsFailed}
                  </p>
                  <Button type="button" variant="secondary" className="min-h-11" onClick={p.selectedTarget.reload}>
                    Recarregar ambientes
                  </Button>
                </div>
              )}
              {!p.preview && (
                <Button
                  type="button"
                  className="min-h-11 w-full"
                  disabled={!p.selection.projectId || working || p.catalogFailed || p.selectedTarget.status !== 'ready'}
                  onClick={() => void p.requestPreview()}
                >
                  Verificar prévia
                </Button>
              )}
              {p.preview && (
                <div className="space-y-3">
                  <SummaryList summary={p.preview.summary} target={p.selectedTarget} />
                  <p className="text-sm text-darc-velvet/70">
                    Atribui este crédito ao custo do projeto escolhido. Não gera novo pagamento nem novo débito.
                  </p>
                  <Button type="button" className="min-h-11 w-full" disabled={working} onClick={() => void p.confirm()}>
                    Confirmar finalidade
                  </Button>
                </div>
              )}
            </div>
          )}

          {p.confirmingUndo ? (
            <div role="group" aria-label="Confirmar desfazer finalidade" className="space-y-3 rounded-lg border border-darc-linen p-3">
              <p className="text-sm">Confirme para desfazer a finalidade deste crédito.</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button ref={cancelRef} type="button" variant="ghost" className="min-h-11" onClick={() => p.setConfirmingUndo(false)}>
                  Cancelar
                </Button>
                <Button type="button" variant="danger" className="min-h-11" disabled={working} onClick={() => void p.undo()}>
                  Desfazer finalidade
                </Button>
              </div>
            </div>
          ) : (
            p.canUndo && (
              <Button type="button" variant="secondary" className="min-h-11 w-full" onClick={() => p.setConfirmingUndo(true)}>
                Desfazer finalidade
              </Button>
            )
          )}
        </>
      )}
    </div>
  );
}
