'use client';
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Edit2, Trash2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import type { Expense, ExpenseStatus } from '@/types';
import {
  groupPersonalExpenses,
  groupOrigemByTipo,
  groupOrigemByRoom,
  totalsOf,
  type RemoteProjectMap,
} from '../_lib/personal-hierarchy';
import { effectiveDate } from '../_lib/grouping-by-month';

interface Props {
  expenses: Expense[];
  remoteMap: RemoteProjectMap;
  selfProjectName: string;
  tipoLabel: (t: string) => string;
  openEdit: (e: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}

function statusButton(e: Expense, onToggle: (next: ExpenseStatus) => void) {
  const isPago = e.status === 'PAGO';
  return (
    <button
      type="button"
      onClick={(ev) => { ev.stopPropagation(); onToggle(isPago ? 'PLANEJADO' : 'PAGO'); }}
      title="Alternar status"
      style={{
        backgroundColor: isPago ? '#16a34a' : '#f59e0b',
        color: '#fff',
        borderRadius: 6,
        padding: '2px 8px',
        fontSize: 11,
        fontWeight: 600,
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {isPago ? 'PAGO' : 'PLANEJADO'}
    </button>
  );
}

function ExpenseRow({
  e, tipoLabel, openEdit, onDelete, onToggleStatus,
}: {
  e: Expense; tipoLabel: (t: string) => string;
  openEdit: (e: Expense) => void; onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  const dt = effectiveDate(e);
  const isParcelado =
    (e.formaPagamento === 'PARCELADO' || e.formaPagamento === 'QUINZENAL') &&
    (e.quantidadeParcela ?? 1) > 1;
  const parcelas = isParcelado ? e.quantidadeParcela! : 0;
  const isQuinzenal = e.formaPagamento === 'QUINZENAL';
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-t border-gray-100 hover:bg-orange-50/40">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 truncate">
          {e.titulo || e.fornecedor || tipoLabel(e.tipoDespesa)}
        </div>
        <div className="text-[10px] text-gray-500">
          {tipoLabel(e.tipoDespesa)}
          {e.room?.name ? ` · ${e.room.name}` : ''}
          {dt ? ` · ${new Date(dt).toLocaleDateString('pt-BR')}` : ''}
          {parcelas ? ` · ${parcelas}x de ${formatCurrency(Math.round(e.valorTotal / parcelas) / 100)}${isQuinzenal ? ' (quinzenal)' : ''}` : ''}
        </div>
      </div>
      <div className="flex flex-col items-end whitespace-nowrap">
        <span className="font-mono text-gray-900 text-xs">
          {formatCurrency(e.valorTotal / 100)}
        </span>
        {parcelas ? (
          <span className="text-[10px] font-semibold text-teal-700">{parcelas}x</span>
        ) : null}
      </div>
      {statusButton(e, (next) => onToggleStatus(e.id, next))}
      <button
        type="button"
        onClick={() => openEdit(e)}
        className="text-blue-600 hover:bg-blue-50 rounded p-1"
        title="Editar"
      >
        <Edit2 className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => { if (confirm('Excluir despesa?')) onDelete(e.id); }}
        className="text-red-500 hover:bg-red-50 rounded p-1"
        title="Excluir"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function TipoBlock({
  tipo, itens, tipoLabel, openEdit, onDelete, onToggleStatus,
}: {
  tipo: string; itens: Expense[];
  tipoLabel: (t: string) => string;
  openEdit: (e: Expense) => void; onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const { pago, planejado } = totalsOf(itens);
  const total = pago + planejado;
  return (
    <div className="border-t border-gray-100 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50"
      >
        {open ? <ChevronDown className="w-3 h-3 text-gray-500" /> : <ChevronRight className="w-3 h-3 text-gray-500" />}
        <span className="font-medium text-gray-700">{tipoLabel(tipo)}</span>
        <span className="text-[10px] text-gray-400">({itens.length})</span>
        <span className="ml-auto font-mono text-gray-900">{formatCurrency(total / 100)}</span>
      </button>
      {open && (
        <div>
          {itens.map((e) => (
            <ExpenseRow
              key={e.id}
              e={e}
              tipoLabel={tipoLabel}
              openEdit={openEdit}
              onDelete={onDelete}
              onToggleStatus={onToggleStatus}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrigemBlock({
  label, kind, itens, isReforma, tipoLabel, openEdit, onDelete, onToggleStatus,
}: {
  label: string; kind: 'CARTAO' | 'EXTRATO' | 'MANUAL'; itens: Expense[];
  isReforma: boolean;
  tipoLabel: (t: string) => string;
  openEdit: (e: Expense) => void; onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  const [open, setOpen] = useState(true);
  const { pago, planejado } = totalsOf(itens);
  const total = pago + planejado;

  const tipoBlocks = useMemo(() => groupOrigemByTipo({ key: '', kind, label, itens }), [itens, kind, label]);
  const roomBlocks = useMemo(
    () => isReforma ? groupOrigemByRoom({ key: '', kind, label, itens }) : [],
    [itens, kind, label, isReforma],
  );

  const accent = kind === 'CARTAO' ? 'bg-purple-50 border-purple-200 text-purple-700'
    : kind === 'EXTRATO' ? 'bg-cyan-50 border-cyan-200 text-cyan-700'
    : 'bg-gray-50 border-gray-200 text-gray-700';

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-xs ${accent} border-b`}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span className="font-semibold">{label}</span>
        <span className="text-[10px] opacity-75">({itens.length})</span>
        <span className="ml-auto font-mono">{formatCurrency(total / 100)}</span>
      </button>
      {open && (
        <div className="bg-white">
          {isReforma ? (
            roomBlocks.map((rg) => (
              <div key={rg.roomKey} className="border-t border-gray-100 first:border-t-0">
                <div className="px-3 py-1 text-[11px] font-semibold text-gray-600 bg-gray-50">
                  🏠 {rg.roomLabel} ({rg.itens.length}) · {formatCurrency(rg.itens.reduce((s, x) => s + x.valorTotal, 0) / 100)}
                </div>
                {groupOrigemByTipo({ key: '', kind, label, itens: rg.itens }).map((tg) => (
                  <TipoBlock
                    key={tg.tipo}
                    tipo={tg.tipo}
                    itens={tg.itens}
                    tipoLabel={tipoLabel}
                    openEdit={openEdit}
                    onDelete={onDelete}
                    onToggleStatus={onToggleStatus}
                  />
                ))}
              </div>
            ))
          ) : (
            tipoBlocks.map((tg) => (
              <TipoBlock
                key={tg.tipo}
                tipo={tg.tipo}
                itens={tg.itens}
                tipoLabel={tipoLabel}
                openEdit={openEdit}
                onDelete={onDelete}
                onToggleStatus={onToggleStatus}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function projectAccent(type: string): { card: string; badge: string } {
  switch (type) {
    case 'REFORMA': return { card: 'border-orange-300', badge: 'bg-orange-100 text-orange-800' };
    case 'CASA': return { card: 'border-emerald-300', badge: 'bg-emerald-100 text-emerald-800' };
    case 'CARRO': return { card: 'border-blue-300', badge: 'bg-blue-100 text-blue-800' };
    case 'COMPRA': return { card: 'border-amber-300', badge: 'bg-amber-100 text-amber-800' };
    default: return { card: 'border-gray-300', badge: 'bg-gray-100 text-gray-800' };
  }
}

export function PersonalHierarchicalView({
  expenses, remoteMap, selfProjectName, tipoLabel, openEdit, onDelete, onToggleStatus,
}: Props) {
  const projects = useMemo(
    () => groupPersonalExpenses(expenses, remoteMap, selfProjectName),
    [expenses, remoteMap, selfProjectName],
  );

  return (
    <div className="space-y-4">
      {projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
          Nenhuma despesa no período selecionado.
        </div>
      )}

      {projects.map((pg) => {
        const accent = projectAccent(pg.projectType);
        return (
          <ProjectCard
            key={pg.projectKey}
            pg={pg}
            accent={accent}
            tipoLabel={tipoLabel}
            openEdit={openEdit}
            onDelete={onDelete}
            onToggleStatus={onToggleStatus}
          />
        );
      })}
    </div>
  );
}

export function projectAccentOf(type: string) {
  return projectAccent(type);
}

export { ProjectCard, OrigemBlock, TipoBlock, ExpenseRow, RoomTipoBlocks };


/**
 * Renderiza o corpo de um projeto: Ambiente → Tipo (REFORMA) ou direto Tipo.
 * O nível de "origem" (cartão/extrato) foi removido — a origem agora é filtrada
 * via chips de cartões/contas acima da lista.
 */
function RoomTipoBlocks({
  itens, isReforma, tipoLabel, openEdit, onDelete, onToggleStatus,
}: {
  itens: Expense[];
  isReforma: boolean;
  tipoLabel: (t: string) => string;
  openEdit: (e: Expense) => void; onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  const tipoBlocks = useMemo(
    () => groupOrigemByTipo({ key: '', kind: 'MANUAL', label: '', itens }),
    [itens],
  );
  const roomBlocks = useMemo(
    () => isReforma ? groupOrigemByRoom({ key: '', kind: 'MANUAL', label: '', itens }) : [],
    [itens, isReforma],
  );

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden bg-white">
      {isReforma ? (
        roomBlocks.map((rg) => (
          <div key={rg.roomKey} className="border-t border-gray-100 first:border-t-0">
            <div className="px-3 py-1 text-[11px] font-semibold text-gray-600 bg-gray-50">
              🏠 {rg.roomLabel} ({rg.itens.length}) · {formatCurrency(rg.itens.reduce((s, x) => s + x.valorTotal, 0) / 100)}
            </div>
            {groupOrigemByTipo({ key: '', kind: 'MANUAL', label: '', itens: rg.itens }).map((tg) => (
              <TipoBlock
                key={tg.tipo}
                tipo={tg.tipo}
                itens={tg.itens}
                tipoLabel={tipoLabel}
                openEdit={openEdit}
                onDelete={onDelete}
                onToggleStatus={onToggleStatus}
              />
            ))}
          </div>
        ))
      ) : (
        tipoBlocks.map((tg) => (
          <TipoBlock
            key={tg.tipo}
            tipo={tg.tipo}
            itens={tg.itens}
            tipoLabel={tipoLabel}
            openEdit={openEdit}
            onDelete={onDelete}
            onToggleStatus={onToggleStatus}
          />
        ))
      )}
    </div>
  );
}


function ProjectCard({
  pg, accent, tipoLabel, openEdit, onDelete, onToggleStatus,
}: {
  pg: ReturnType<typeof groupPersonalExpenses>[number];
  accent: { card: string; badge: string };
  tipoLabel: (t: string) => string;
  openEdit: (e: Expense) => void; onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  const [open, setOpen] = useState(true);
  const total = pg.totalPago + pg.totalPlanejado;
  const isReforma = pg.projectType === 'REFORMA';
  return (
    <div className={`rounded-xl border-2 ${accent.card} bg-white overflow-hidden shadow-sm`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span className="font-bold text-gray-900 text-sm">{pg.projectName}</span>
        <span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 ${accent.badge}`}>
          {pg.projectType}
        </span>
        <span className="text-xs text-gray-500">{pg.itens.length} itens</span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="text-emerald-700 font-mono">{formatCurrency(pg.totalPago / 100)}</span>
          <span className="text-gray-300">·</span>
          <span className="text-amber-700 font-mono">{formatCurrency(pg.totalPlanejado / 100)}</span>
          <span className="text-gray-300">=</span>
          <span className="font-mono font-bold text-gray-900">{formatCurrency(total / 100)}</span>
        </div>
      </button>
      {open && (
        <div className="p-3 bg-gray-50/40">
          <RoomTipoBlocks
            itens={pg.itens}
            isReforma={isReforma}
            tipoLabel={tipoLabel}
            openEdit={openEdit}
            onDelete={onDelete}
            onToggleStatus={onToggleStatus}
          />
        </div>
      )}
    </div>
  );
}
