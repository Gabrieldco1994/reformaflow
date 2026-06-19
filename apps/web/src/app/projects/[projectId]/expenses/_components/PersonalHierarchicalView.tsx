'use client';
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import type { Expense, ExpenseStatus } from '@/types';
import {
  groupPersonalExpenses,
  groupOrigemByTipo,
  groupOrigemByRoom,
  totalsOf,
  type RemoteProjectMap,
} from '../_lib/personal-hierarchy';
import PersonalExpenseCard, { type PersonalCardInfo } from './PersonalExpenseCard';

interface Props {
  expenses: Expense[];
  remoteMap: RemoteProjectMap;
  selfProjectName: string;
  tipoLabel: (t: string) => string;
  cardInfoByLast4?: Map<string, PersonalCardInfo>;
  openEdit: (e: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}

function ExpenseRow({
  e, tipoLabel, cardInfoByLast4, openEdit, onDelete, onToggleStatus,
}: {
  e: Expense; tipoLabel: (t: string) => string;
  cardInfoByLast4?: Map<string, PersonalCardInfo>;
  openEdit: (e: Expense) => void; onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  return (
    <PersonalExpenseCard
      expense={e}
      tipoLabel={tipoLabel}
      cardInfoByLast4={cardInfoByLast4}
      onEdit={openEdit}
      onDelete={onDelete}
      onToggleStatus={onToggleStatus}
    />
  );
}

function TipoBlock({
  tipo, itens, tipoLabel, cardInfoByLast4, openEdit, onDelete, onToggleStatus,
}: {
  tipo: string; itens: Expense[];
  tipoLabel: (t: string) => string;
  cardInfoByLast4?: Map<string, PersonalCardInfo>;
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
        <div className="space-y-1.5 p-1.5 md:space-y-2 md:p-2">
          {itens.map((e) => (
            <ExpenseRow
              key={e.id}
              e={e}
              tipoLabel={tipoLabel}
              cardInfoByLast4={cardInfoByLast4}
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
  label, kind, itens, isReforma, tipoLabel, cardInfoByLast4, openEdit, onDelete, onToggleStatus,
}: {
  label: string; kind: 'CARTAO' | 'EXTRATO' | 'MANUAL'; itens: Expense[];
  isReforma: boolean;
  tipoLabel: (t: string) => string;
  cardInfoByLast4?: Map<string, PersonalCardInfo>;
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
                    cardInfoByLast4={cardInfoByLast4}
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
                cardInfoByLast4={cardInfoByLast4}
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
  expenses, remoteMap, selfProjectName, tipoLabel, cardInfoByLast4, openEdit, onDelete, onToggleStatus,
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
            cardInfoByLast4={cardInfoByLast4}
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
  itens, isReforma, tipoLabel, cardInfoByLast4, openEdit, onDelete, onToggleStatus,
}: {
  itens: Expense[];
  isReforma: boolean;
  tipoLabel: (t: string) => string;
  cardInfoByLast4?: Map<string, PersonalCardInfo>;
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
                cardInfoByLast4={cardInfoByLast4}
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
            cardInfoByLast4={cardInfoByLast4}
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
  pg, accent, tipoLabel, cardInfoByLast4, openEdit, onDelete, onToggleStatus,
}: {
  pg: ReturnType<typeof groupPersonalExpenses>[number];
  accent: { card: string; badge: string };
  tipoLabel: (t: string) => string;
  cardInfoByLast4?: Map<string, PersonalCardInfo>;
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
            cardInfoByLast4={cardInfoByLast4}
            openEdit={openEdit}
            onDelete={onDelete}
            onToggleStatus={onToggleStatus}
          />
        </div>
      )}
    </div>
  );
}
