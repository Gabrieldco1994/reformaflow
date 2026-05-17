'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { ShoppingCart } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { ExpenseTypeLabels } from '@reformaflow/domain';
import type { Expense } from '@/types';
import { SortableCard } from './SortableCard';

export function CompráveisView({ expenses, tipoLabel }: { expenses: Expense[]; tipoLabel: (t: string) => string }) {
  const [filterTipo, setFilterTipo] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [sortBy, setSortBy] = useState<'valor' | 'titulo' | 'custom'>('custom');
  const [cardOrder, setCardOrder] = useState<Record<string, string[]>>({});
  const [colsPerRow, setColsPerRow] = useState<3 | 4>(3);

  // Load saved order from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('compraveis-order');
      if (saved) setCardOrder(JSON.parse(saved));
      const savedCols = localStorage.getItem('compraveis-cols');
      if (savedCols === '4' || savedCols === '3') setColsPerRow(Number(savedCols) as 3 | 4);
    } catch {}
  }, []);

  const changeCols = useCallback((n: 3 | 4) => {
    setColsPerRow(n);
    try {
      localStorage.setItem('compraveis-cols', String(n));
    } catch {}
  }, []);

  const saveOrder = useCallback((order: Record<string, string[]>) => {
    setCardOrder(order);
    localStorage.setItem('compraveis-order', JSON.stringify(order));
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const compraveis = useMemo(() => {
    let items = expenses.filter(
      (e) => e.link && e.tipoDespesa !== 'MATERIAL_CONSTRUCAO'
    );
    if (filterTipo) items = items.filter((e) => e.tipoDespesa === filterTipo);
    if (filterStatus) items = items.filter((e) => e.status === filterStatus);

    if (sortBy === 'valor') {
      items.sort((a, b) => b.valorTotal - a.valorTotal);
    } else if (sortBy === 'titulo') {
      items.sort((a, b) => (a.titulo ?? '').localeCompare(b.titulo ?? ''));
    }
    // 'custom' uses cardOrder per room group

    return items;
  }, [expenses, filterTipo, filterStatus, sortBy]);

  const totalCompraveis = compraveis.reduce((s, e) => s + e.valorTotal, 0);

  // Available tipos (only those with links, excluding Material Construção)
  const availableTipos = useMemo(() => {
    const tipos = new Set(
      expenses
        .filter((e) => e.link && e.tipoDespesa !== 'MATERIAL_CONSTRUCAO')
        .map((e) => e.tipoDespesa)
    );
    return Array.from(tipos).map(t => ({ value: t, label: ExpenseTypeLabels[t as keyof typeof ExpenseTypeLabels] ?? t }));
  }, [expenses]);

  // Group by room and apply custom order
  const groupedRooms = useMemo(() => {
    const grouped = new Map<string, Expense[]>();
    compraveis.forEach((e) => {
      const roomName = e.room?.name || 'Sem ambiente';
      if (!grouped.has(roomName)) grouped.set(roomName, []);
      grouped.get(roomName)!.push(e);
    });

    return Array.from(grouped.entries())
      .sort(([a], [b]) => a === 'Sem ambiente' ? 1 : b === 'Sem ambiente' ? -1 : a.localeCompare(b))
      .map(([roomName, items]) => {
        // Apply custom order if sortBy is 'custom'
        if (sortBy === 'custom' && cardOrder[roomName]) {
          const order = cardOrder[roomName];
          const ordered: Expense[] = [];
          const remaining = [...items];
          order.forEach((id) => {
            const idx = remaining.findIndex((e) => e.id === id);
            if (idx >= 0) ordered.push(...remaining.splice(idx, 1));
          });
          return { roomName, items: [...ordered, ...remaining] };
        }
        return { roomName, items };
      });
  }, [compraveis, sortBy, cardOrder]);

  const handleDragEnd = useCallback((roomName: string) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const room = groupedRooms.find((g) => g.roomName === roomName);
    if (!room) return;

    const oldIndex = room.items.findIndex((e) => e.id === active.id);
    const newIndex = room.items.findIndex((e) => e.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const newItems = arrayMove(room.items, oldIndex, newIndex);
    const newOrder = { ...cardOrder, [roomName]: newItems.map((e) => e.id) };
    saveOrder(newOrder);
    setSortBy('custom');
  }, [groupedRooms, cardOrder, saveOrder]);

  return (
    <div className="space-y-4">
      {/* Summary + Filters */}
      <div className="bg-gradient-to-r from-orange-50 to-amber-50 rounded-xl p-4 border border-orange-100">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-orange-500" />
              {compraveis.length} {compraveis.length === 1 ? 'item comprável' : 'itens compráveis'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">Total: <span className="font-bold text-orange-700">{formatCurrency(totalCompraveis / 100)}</span></p>
          </div>
          <div className="flex gap-2">
            <select
              value={filterTipo}
              onChange={(e) => setFilterTipo(e.target.value)}
              className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300"
            >
              <option value="">Todos os tipos</option>
              {availableTipos.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300"
            >
              <option value="">Todos os status</option>
              <option value="PLANEJADO">Planejado</option>
              <option value="PAGO">Pago</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'valor' | 'titulo' | 'custom')}
              className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300"
            >
              <option value="custom">Manual (arrastar)</option>
              <option value="valor">Maior valor</option>
              <option value="titulo">A–Z</option>
            </select>
            <div className="hidden lg:inline-flex items-center gap-1 text-xs bg-white border rounded-lg px-2 py-1" title="Itens por linha">
              <span className="text-gray-400">Por linha:</span>
              <button
                type="button"
                onClick={() => changeCols(3)}
                className={`px-1.5 rounded ${colsPerRow === 3 ? 'bg-orange-100 text-orange-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}
              >
                3
              </button>
              <button
                type="button"
                onClick={() => changeCols(4)}
                className={`px-1.5 rounded ${colsPerRow === 4 ? 'bg-orange-100 text-orange-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}
              >
                4
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Cards grouped by Room */}
      {compraveis.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <ShoppingCart className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum item comprável encontrado</p>
          <p className="text-xs mt-1">Despesas com link preenchido (exceto Material de Construção) aparecerão aqui</p>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedRooms.map(({ roomName, items }) => (
            <div key={roomName}>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-sm font-bold text-gray-700">🏠 {roomName}</h3>
                <span className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{items.length} {items.length === 1 ? 'item' : 'itens'}</span>
                <span className="text-[10px] text-gray-500 ml-auto font-medium">{formatCurrency(items.reduce((s, e) => s + e.valorTotal, 0) / 100)}</span>
              </div>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd(roomName)}
              >
                <SortableContext items={items.map((e) => e.id)} strategy={rectSortingStrategy}>
                  <div className={`grid grid-cols-2 sm:grid-cols-2 ${colsPerRow === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-2 sm:gap-5`}>
                    {items.map((expense) => (
                      <SortableCard key={expense.id} expense={expense} tipoLabel={tipoLabel} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

