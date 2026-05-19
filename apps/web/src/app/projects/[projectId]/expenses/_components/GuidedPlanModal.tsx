'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ChevronLeft, ChevronRight, ArrowLeft, ArrowRight, MapPin, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';
import { formatCurrency } from '@/lib/utils';
import type { Expense } from '@/types';
import { LinkPreviewImage } from './LinkPreviewImage';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface FloorPlanRoom {
  id: string;
  floorPlanId: string;
  roomId: string | null;
  label: string;
  bounds: string;
  color: string;
  room?: { id: string; name: string };
}

interface FloorPlanMarker {
  id: string;
  floorPlanId: string;
  expenseId: string;
  bounds: string;
  expense: {
    id: string;
    titulo: string | null;
    valorTotal: number;
    imageUrl: string | null;
    link: string | null;
  };
}

interface FloorPlan {
  id: string;
  name: string;
  imageUrl: string;
  rooms: FloorPlanRoom[];
  markers?: FloorPlanMarker[];
}

interface Bounds {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export function GuidedPlanModal({
  expenses,
  onClose,
  onFocusExpense,
  initialAmbiente,
}: {
  expenses: Expense[];
  onClose: () => void;
  onFocusExpense: (id: string) => void;
  initialAmbiente: string | null;
}) {
  const { projectId: PROJECT_ID } = useProject();
  const { data: floorPlans = [] } = useQuery<FloorPlan[]>({
    queryKey: ['floor-plans', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/floor-plans`),
  });

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [removeWhiteBg, setRemoveWhiteBg] = useState(true);
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null);

  const safeIdx = selectedIdx >= floorPlans.length ? 0 : selectedIdx;
  const plan = floorPlans[safeIdx];

  useEffect(() => {
    if (selectedIdx !== safeIdx) setSelectedIdx(safeIdx);
  }, [selectedIdx, safeIdx]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('compraveis-guided-prefs');
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p.removeWhiteBg === 'boolean') setRemoveWhiteBg(p.removeWhiteBg);
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('compraveis-guided-prefs', JSON.stringify({ removeWhiteBg }));
    } catch { /* ignore */ }
  }, [removeWhiteBg]);

  const rooms = plan?.rooms ?? [];
  const markers = plan?.markers ?? [];

  const parsedRooms = useMemo(
    () =>
      rooms
        .map((r) => {
          try { return { ...r, _bounds: JSON.parse(r.bounds) as Bounds }; }
          catch { return null; }
        })
        .filter(Boolean) as (FloorPlanRoom & { _bounds: Bounds })[],
    [rooms],
  );

  const navRooms = useMemo(
    () =>
      parsedRooms
        .filter((r) => r.room?.name)
        .sort((a, b) => {
          const c = (a.room!.name).localeCompare(b.room!.name);
          return c !== 0 ? c : a.id.localeCompare(b.id);
        }),
    [parsedRooms],
  );

  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (!initialAmbiente) return;
    const first = navRooms.find((r) => r.room?.name === initialAmbiente);
    if (first) setActiveRoomId(first.id);
  }, [initialAmbiente, navRooms]);

  const activeRoom = useMemo(
    () => navRooms.find((r) => r.id === activeRoomId) ?? null,
    [navRooms, activeRoomId],
  );

  const goPrev = useCallback(() => {
    setActiveRoomId((current) => {
      if (navRooms.length === 0) return current;
      if (!current) return navRooms[0].id;
      const i = navRooms.findIndex((r) => r.id === current);
      if (i < 0) return navRooms[0].id;
      return navRooms[(i - 1 + navRooms.length) % navRooms.length].id;
    });
  }, [navRooms]);

  const goNext = useCallback(() => {
    setActiveRoomId((current) => {
      if (navRooms.length === 0) return current;
      if (!current) return navRooms[0].id;
      const i = navRooms.findIndex((r) => r.id === current);
      if (i < 0) return navRooms[0].id;
      return navRooms[(i + 1) % navRooms.length].id;
    });
  }, [navRooms]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'Escape') { e.preventDefault(); if (activeRoomId) setActiveRoomId(null); else onClose(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [goPrev, goNext, onClose, activeRoomId]);

  // Zoom só quando há cômodo ativo — SEM cropBounds (estava deslocando marcações)
  const zoomStyle = useMemo<React.CSSProperties>(() => {
    const transition = 'transform 700ms cubic-bezier(.22,1,.36,1)';
    if (activeRoom) {
      const b = activeRoom._bounds;
      const cx = b.x + (b.width ?? 0) / 2;
      const cy = b.y + (b.height ?? 0) / 2;
      const targetSize = 60;
      const roomMax = Math.max(b.width ?? 30, b.height ?? 30);
      const zoom = Math.min(2.4, Math.max(1.4, targetSize / roomMax));
      return {
        transform: `scale(${zoom})`,
        transformOrigin: `${cx}% ${cy}%`,
        transition,
      };
    }
    return { transform: 'scale(1)', transformOrigin: '50% 50%', transition };
  }, [activeRoom]);

  const activeRoomName = activeRoom?.room?.name ?? null;

  const sidebarItems = useMemo(() => {
    return expenses.filter((e) => {
      if (!e.link) return false;
      if (e.tipoDespesa === 'MAO_DE_OBRA' || e.tipoDespesa === 'MATERIAL_CONSTRUCAO') return false;
      if (activeRoomName && e.room?.name !== activeRoomName) return false;
      return true;
    });
  }, [expenses, activeRoomName]);

  const sidebarTotals = useMemo(() => {
    let pago = 0;
    let planejado = 0;
    for (const e of sidebarItems) {
      if (e.status === 'PAGO') pago += e.valorTotal;
      else planejado += e.valorTotal;
    }
    return { pago, planejado, total: pago + planejado };
  }, [sidebarItems]);

  const activeIdx = activeRoom ? navRooms.findIndex((r) => r.id === activeRoom.id) : -1;

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/95 backdrop-blur-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gradient-to-r from-orange-600 to-amber-600 text-white shadow-lg shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MapPin className="w-4 h-4 shrink-0" />
          <span className="text-sm font-semibold truncate">
            {plan?.name ?? 'Planta'}{activeRoomName ? ` — ${activeRoomName}` : ''}
          </span>
          {activeRoom && activeIdx >= 0 && (
            <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded-full">{activeIdx + 1}/{navRooms.length}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {floorPlans.length > 1 && (
            <select
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
              className="text-xs text-gray-700 px-2 py-1 rounded bg-white"
            >
              {floorPlans.map((fp, i) => (
                <option key={fp.id} value={i}>{fp.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => setRemoveWhiteBg((v) => !v)}
            className="text-[11px] flex items-center gap-1 px-2 py-1 rounded bg-white/15 hover:bg-white/25 transition-colors"
            title="Alterna remoção do fundo branco"
          >
            {removeWhiteBg ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            {removeWhiteBg ? 'Sem fundo' : 'Com fundo'}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/20 transition-colors"
            title="Fechar (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        {/* Planta — fullscreen */}
        <div className="flex-1 relative bg-[linear-gradient(45deg,#fff8f0_25%,transparent_25%,transparent_75%,#fff8f0_75%),linear-gradient(45deg,#fff8f0_25%,transparent_25%,transparent_75%,#fff8f0_75%)] bg-[length:16px_16px] bg-[position:0_0,8px_8px] overflow-hidden">
          {plan?.imageUrl ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="relative inline-block max-h-full max-w-full" style={zoomStyle}>
                <img
                  src={`${API_BASE}${plan.imageUrl}`}
                  alt={plan.name}
                  className="max-h-[calc(100vh-100px)] max-w-full block"
                  style={removeWhiteBg ? { mixBlendMode: 'multiply' } : undefined}
                />

                {parsedRooms.map((room) => {
                  const isActive = activeRoom?.id === room.id;
                  const isHover = hoveredRoomId === room.id;
                  return (
                    <button
                      key={room.id}
                      onClick={() => {
                        if (isActive) setActiveRoomId(null);
                        else setActiveRoomId(room.id);
                      }}
                      onMouseEnter={() => setHoveredRoomId(room.id)}
                      onMouseLeave={() => setHoveredRoomId((id) => (id === room.id ? null : id))}
                      disabled={!room.room?.name}
                      className="absolute border-2 transition-all"
                      style={{
                        left: `${room._bounds.x}%`,
                        top: `${room._bounds.y}%`,
                        width: `${room._bounds.width ?? 0}%`,
                        height: `${room._bounds.height ?? 0}%`,
                        borderColor: room.color,
                        backgroundColor: `${room.color}${isActive ? '40' : isHover ? '30' : '15'}`,
                        boxShadow: isActive ? `0 0 0 2px ${room.color}, 0 4px 12px rgba(0,0,0,.25)` : undefined,
                        cursor: room.room?.name ? 'pointer' : 'default',
                      }}
                      title={room.room?.name ?? room.label}
                    >
                      <span
                        className="absolute top-0 left-0 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white rounded-br-md"
                        style={{ backgroundColor: room.color }}
                      >
                        {room.room?.name ?? room.label}
                      </span>
                    </button>
                  );
                })}

                {markers.map((m) => {
                  let b: Bounds;
                  try { b = JSON.parse(m.bounds); } catch { return null; }
                  const isHover = hoveredMarker === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => onFocusExpense(m.expenseId)}
                      onMouseEnter={() => setHoveredMarker(m.id)}
                      onMouseLeave={() => setHoveredMarker((id) => (id === m.id ? null : id))}
                      className="absolute z-20"
                      style={{
                        left: `${b.x}%`,
                        top: `${b.y}%`,
                        width: `${b.width ?? 2}%`,
                        height: `${b.height ?? 2}%`,
                      }}
                      title={m.expense.titulo ?? ''}
                    >
                      <div className="w-full h-full bg-orange-500/40 hover:bg-orange-500/60 border-2 border-white rounded-full shadow-lg" />
                      {isHover && (
                        <div className="absolute z-30 pointer-events-none bottom-full left-1/2 -translate-x-1/2 mb-1 w-32 rounded-lg bg-white shadow-2xl overflow-hidden border border-orange-200">
                          <div className="h-20 bg-gray-50 flex items-center justify-center">
                            <LinkPreviewImage
                              imageUrl={m.expense.imageUrl}
                              link={m.expense.link}
                              alt={m.expense.titulo ?? ''}
                              className="max-w-full max-h-full object-contain"
                            />
                          </div>
                          <div className="p-1.5">
                            <p className="text-[10px] font-semibold text-gray-800 line-clamp-2">{m.expense.titulo}</p>
                            <p className="text-[10px] font-bold text-orange-700 mt-0.5">{formatCurrency(m.expense.valorTotal / 100)}</p>
                          </div>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-white/60 text-sm">
              Nenhuma planta encontrada
            </div>
          )}

          {/* Navegação setas — sobreposta na imagem */}
          {navRooms.length > 0 && (
            <>
              <button
                onClick={goPrev}
                className="absolute left-4 top-1/2 -translate-y-1/2 z-30 p-3 rounded-full bg-white/85 hover:bg-white shadow-xl text-gray-800 transition-all hover:scale-110"
                title="Cômodo anterior (←)"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <button
                onClick={goNext}
                className="absolute right-4 top-1/2 -translate-y-1/2 z-30 p-3 rounded-full bg-white/85 hover:bg-white shadow-xl text-gray-800 transition-all hover:scale-110"
                title="Próximo cômodo (→)"
              >
                <ArrowRight className="w-5 h-5" />
              </button>
              {/* Lista compacta de cômodos no rodapé */}
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex gap-1 px-2 py-1.5 rounded-full bg-black/60 backdrop-blur-sm max-w-[80vw] overflow-x-auto">
                {navRooms.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setActiveRoomId(r.id)}
                    className={`text-[10px] px-2 py-1 rounded-full whitespace-nowrap transition-colors ${
                      activeRoom?.id === r.id
                        ? 'bg-orange-500 text-white font-semibold'
                        : 'bg-white/15 text-white/80 hover:bg-white/25'
                    }`}
                  >
                    {r.room?.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Sidebar — items do ambiente ativo */}
        <aside className="w-[320px] lg:w-[360px] shrink-0 bg-white border-l border-gray-200 flex flex-col overflow-hidden">
          <div className="px-3 py-2 bg-gradient-to-r from-orange-50 to-amber-50 border-b border-orange-100">
            <p className="text-[11px] uppercase tracking-wider text-orange-700 font-bold">
              {activeRoomName ? activeRoomName : 'Todos os ambientes'}
            </p>
            <p className="text-[10px] text-gray-500 mt-0.5">{sidebarItems.length} {sidebarItems.length === 1 ? 'item' : 'itens'}</p>
            <div className="grid grid-cols-3 gap-1 mt-1.5 text-[10px]">
              <div className="bg-emerald-50 rounded px-1.5 py-1">
                <p className="text-emerald-700">Pago</p>
                <p className="font-bold text-emerald-800">{formatCurrency(sidebarTotals.pago / 100)}</p>
              </div>
              <div className="bg-orange-50 rounded px-1.5 py-1">
                <p className="text-orange-700">Previsto</p>
                <p className="font-bold text-orange-800">{formatCurrency(sidebarTotals.planejado / 100)}</p>
              </div>
              <div className="bg-gray-50 rounded px-1.5 py-1">
                <p className="text-gray-700">Total</p>
                <p className="font-bold text-gray-900">{formatCurrency(sidebarTotals.total / 100)}</p>
              </div>
            </div>
            {activeRoomName && (
              <button
                onClick={() => setActiveRoomId(null)}
                className="mt-1.5 text-[10px] text-gray-500 hover:text-gray-700 underline"
              >
                Ver todos os ambientes
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {sidebarItems.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                <MapPin className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-xs">Nenhum item neste ambiente</p>
              </div>
            ) : (
              sidebarItems.map((e) => (
                <button
                  key={e.id}
                  onClick={() => onFocusExpense(e.id)}
                  className="w-full text-left p-1.5 rounded-lg border border-gray-200 hover:border-orange-300 hover:bg-orange-50 transition-colors flex gap-2 group"
                  title={e.titulo ?? ''}
                >
                  <div className="w-14 h-14 bg-gray-50 rounded shrink-0 overflow-hidden flex items-center justify-center">
                    <LinkPreviewImage
                      imageUrl={e.imageUrl ?? null}
                      link={e.link ?? null}
                      alt={e.titulo ?? ''}
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold text-gray-800 line-clamp-2 leading-tight">{e.titulo}</p>
                    <div className="flex items-center justify-between mt-0.5 gap-1">
                      <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${e.status === 'PAGO' ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'}`}>
                        {e.status === 'PAGO' ? '✓ pago' : 'previsto'}
                      </span>
                      <span className="text-xs font-bold text-orange-700 truncate">{formatCurrency(e.valorTotal / 100)}</span>
                    </div>
                    {e.link && (
                      <a
                        href={e.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(ev) => ev.stopPropagation()}
                        className="inline-flex items-center gap-0.5 text-[9px] text-orange-600 hover:text-orange-800 mt-0.5"
                      >
                        <ExternalLink className="w-2.5 h-2.5" /> abrir link
                      </a>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>

          {navRooms.length > 0 && (
            <div className="border-t border-gray-200 px-2 py-1.5 flex items-center justify-between bg-gray-50">
              <button
                onClick={goPrev}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-white border hover:bg-orange-50 hover:border-orange-300"
                title="←"
              >
                <ChevronLeft className="w-3 h-3" /> Anterior
              </button>
              <button
                onClick={goNext}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-white border hover:bg-orange-50 hover:border-orange-300"
                title="→"
              >
                Próximo <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
