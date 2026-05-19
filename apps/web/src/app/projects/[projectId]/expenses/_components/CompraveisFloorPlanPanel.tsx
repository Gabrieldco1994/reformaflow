'use client';

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin, ChevronLeft, ChevronRight, Eye, EyeOff, ArrowLeft, ArrowRight, Home } from 'lucide-react';
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
  cropBounds?: string | null;
  rooms: FloorPlanRoom[];
  markers?: FloorPlanMarker[];
}

interface Bounds {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export function CompraveisFloorPlanPanel({
  filterAmbiente,
  onFilterAmbiente,
  onFocusExpense,
  expenses = [],
}: {
  filterAmbiente: string | null;
  onFilterAmbiente: (name: string | null) => void;
  onFocusExpense: (expenseId: string) => void;
  expenses?: Expense[];
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
  const [collapsed, setCollapsed] = useState(false);

  const plan = floorPlans[selectedIdx];

  // Agrupa expenses por nome do ambiente, calculando totais e amostra de imagens
  const expensesByAmbiente = useMemo(() => {
    const map = new Map<string, { items: Expense[]; pago: number; planejado: number }>();
    for (const e of expenses) {
      const name = e.room?.name;
      if (!name || !e.link) continue;
      if (e.tipoDespesa === 'MAO_DE_OBRA' || e.tipoDespesa === 'MATERIAL_CONSTRUCAO') continue;
      let agg = map.get(name);
      if (!agg) { agg = { items: [], pago: 0, planejado: 0 }; map.set(name, agg); }
      agg.items.push(e);
      if (e.status === 'PAGO') agg.pago += e.valorTotal;
      else agg.planejado += e.valorTotal;
    }
    return map;
  }, [expenses]);

  useEffect(() => {
    if (selectedIdx >= floorPlans.length) setSelectedIdx(0);
  }, [floorPlans.length, selectedIdx]);

  // Restore saved preferences
  useEffect(() => {
    try {
      const saved = localStorage.getItem('compraveis-floorplan-prefs');
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p.collapsed === 'boolean') setCollapsed(p.collapsed);
        if (typeof p.removeWhiteBg === 'boolean') setRemoveWhiteBg(p.removeWhiteBg);
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('compraveis-floorplan-prefs', JSON.stringify({ collapsed, removeWhiteBg }));
    } catch { /* ignore */ }
  }, [collapsed, removeWhiteBg]);

  const rooms = plan?.rooms ?? [];
  const markers = plan?.markers ?? [];

  const parsedRooms = useMemo(() => rooms.map((r) => {
    try { return { ...r, _bounds: JSON.parse(r.bounds) as Bounds }; } catch { return null; }
  }).filter(Boolean) as (FloorPlanRoom & { _bounds: Bounds })[], [rooms]);

  // Lista de cômodos navegáveis (com nome vinculado), ordenada por nome (estável por id)
  const navRooms = useMemo(
    () => parsedRooms
      .filter((r) => r.room?.name)
      .sort((a, b) => {
        const c = (a.room!.name).localeCompare(b.room!.name);
        return c !== 0 ? c : a.id.localeCompare(b.id);
      }),
    [parsedRooms],
  );

  // ID do cômodo ativo (necessário para distinguir entre cômodos com mesmo nome,
  // ex.: duas "Área de Serviço"). filterAmbiente filtra por nome — pode mapear pra N rooms.
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  const activeRoom = useMemo(() => {
    if (!filterAmbiente) return null;
    if (activeRoomId) {
      const byId = navRooms.find((r) => r.id === activeRoomId);
      if (byId && byId.room?.name === filterAmbiente) return byId;
    }
    return navRooms.find((r) => r.room?.name === filterAmbiente) ?? null;
  }, [filterAmbiente, navRooms, activeRoomId]);

  // Sincroniza activeRoomId quando muda externamente / quando perdeu validade
  useEffect(() => {
    if (!filterAmbiente) { setActiveRoomId(null); return; }
    if (!activeRoomId || !navRooms.some((r) => r.id === activeRoomId && r.room?.name === filterAmbiente)) {
      const first = navRooms.find((r) => r.room?.name === filterAmbiente);
      setActiveRoomId(first?.id ?? null);
    }
  }, [filterAmbiente, navRooms, activeRoomId]);

  const setActive = useCallback((room: (FloorPlanRoom & { _bounds: Bounds }) | null) => {
    if (!room || !room.room?.name) {
      setActiveRoomId(null);
      onFilterAmbiente(null);
      return;
    }
    setActiveRoomId(room.id);
    onFilterAmbiente(room.room.name);
  }, [onFilterAmbiente]);

  const goPrev = useCallback(() => {
    if (navRooms.length === 0) return;
    if (!activeRoom) { setActive(navRooms[0]); return; }
    const i = navRooms.findIndex((r) => r.id === activeRoom.id);
    setActive(navRooms[(i - 1 + navRooms.length) % navRooms.length]);
  }, [navRooms, activeRoom, setActive]);

  const goNext = useCallback(() => {
    if (navRooms.length === 0) return;
    if (!activeRoom) { setActive(navRooms[0]); return; }
    const i = navRooms.findIndex((r) => r.id === activeRoom.id);
    setActive(navRooms[(i + 1) % navRooms.length]);
  }, [navRooms, activeRoom, setActive]);

  // Atalhos de teclado
  useEffect(() => {
    if (collapsed) return;
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'Escape' && activeRoom) { e.preventDefault(); setActive(null); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [goPrev, goNext, activeRoom, collapsed, setActive]);

  // Zoom transform — combina crop salvo + zoom no cômodo ativo
  const cropBounds = useMemo<Bounds | null>(() => {
    if (!plan?.cropBounds) return null;
    try { return JSON.parse(plan.cropBounds) as Bounds; } catch { return null; }
  }, [plan?.cropBounds]);

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
    if (cropBounds && cropBounds.width && cropBounds.height) {
      const cx = cropBounds.x + cropBounds.width / 2;
      const cy = cropBounds.y + cropBounds.height / 2;
      const s = Math.min(100 / cropBounds.width, 100 / cropBounds.height);
      return {
        transform: `scale(${s})`,
        transformOrigin: `${cx}% ${cy}%`,
        transition,
      };
    }
    return { transform: 'scale(1)', transformOrigin: '50% 50%', transition };
  }, [activeRoom, cropBounds]);

  if (floorPlans.length === 0) return null;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium text-gray-600 bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-100 rounded-xl hover:bg-orange-100 transition-colors"
      >
        <MapPin className="w-3.5 h-3.5 text-orange-500" />
        Mostrar planta ({rooms.length} cômodos · {markers.length} objetos marcados)
      </button>
    );
  }

  return (
    <div className="border border-orange-100 rounded-xl bg-gradient-to-br from-orange-50/40 to-amber-50/40 overflow-hidden lg:h-full lg:flex lg:flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-white/60 border-b border-orange-100 lg:shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MapPin className="w-4 h-4 text-orange-500 shrink-0" />
          <span className="text-xs font-semibold text-gray-700 truncate">
            {plan?.name ?? 'Planta'}
          </span>
          {floorPlans.length > 1 && (
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={() => setSelectedIdx((i) => (i - 1 + floorPlans.length) % floorPlans.length)}
                className="p-0.5 rounded hover:bg-gray-100 text-gray-400"
                title="Anterior"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] text-gray-500">{selectedIdx + 1}/{floorPlans.length}</span>
              <button
                onClick={() => setSelectedIdx((i) => (i + 1) % floorPlans.length)}
                className="p-0.5 rounded hover:bg-gray-100 text-gray-400"
                title="Próxima"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {navRooms.length > 0 && (
            <div className="flex items-center gap-1 mr-1 px-1.5 py-0.5 rounded-md bg-white/70 border border-orange-200">
              <button
                onClick={goPrev}
                className="p-0.5 rounded hover:bg-orange-100 text-orange-600"
                title="Cômodo anterior (←)"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] font-semibold text-gray-700 px-1 min-w-[34px] text-center tabular-nums">
                {activeRoom
                  ? `${navRooms.findIndex((r) => r.id === activeRoom.id) + 1}/${navRooms.length}`
                  : `–/${navRooms.length}`}
              </span>
              <button
                onClick={goNext}
                className="p-0.5 rounded hover:bg-orange-100 text-orange-600"
                title="Próximo cômodo (→)"
              >
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              {activeRoom && (
                <button
                  onClick={() => setActive(null)}
                  className="p-0.5 rounded hover:bg-gray-100 text-gray-400 ml-0.5"
                  title="Limpar filtro (Esc)"
                >
                  <Home className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          {filterAmbiente && (
            <button
              onClick={() => setActive(null)}
              className="text-[10px] bg-orange-500 text-white px-2 py-0.5 rounded-full hover:bg-orange-600"
            >
              {filterAmbiente} ✕
            </button>
          )}
          <button
            onClick={() => setRemoveWhiteBg((v) => !v)}
            className={`p-1 rounded transition-colors ${removeWhiteBg ? 'bg-orange-100 text-orange-700' : 'text-gray-400 hover:bg-gray-100'}`}
            title={removeWhiteBg ? 'Fundo transparente (ON)' : 'Fundo branco original (OFF)'}
          >
            {removeWhiteBg ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="text-[10px] text-gray-400 hover:text-gray-700 px-1.5"
            title="Recolher"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Image + overlays */}
      <div className="relative bg-[linear-gradient(45deg,#fff8f0_25%,transparent_25%,transparent_75%,#fff8f0_75%),linear-gradient(45deg,#fff8f0_25%,transparent_25%,transparent_75%,#fff8f0_75%)] bg-[length:16px_16px] bg-[position:0_0,8px_8px] lg:flex-1 lg:min-h-0">
        <div className="relative w-full h-[55vh] sm:h-[65vh] lg:h-full flex items-center justify-center overflow-hidden">
          {plan?.imageUrl && (
            <div className="relative inline-block max-h-full max-w-full" style={zoomStyle}>
              <img
                src={`${API_BASE}${plan.imageUrl}`}
                alt={plan.name}
                className="max-h-[55vh] sm:max-h-[65vh] lg:max-h-full max-w-full block"
                style={removeWhiteBg ? { mixBlendMode: 'multiply' } : undefined}
              />

              {/* Room areas */}
              {parsedRooms.map((room) => {
                const sameName = filterAmbiente && room.room?.name === filterAmbiente;
                const isActive = activeRoom?.id === room.id;
                const isHighlighted = filterAmbiente ? sameName : true;
                const isHover = hoveredRoomId === room.id;
                const agg = room.room?.name ? expensesByAmbiente.get(room.room.name) : null;
                const tipCount = agg?.items.length ?? 0;
                return (
                  <div key={room.id}>
                    <button
                      onClick={() => {
                        if (isActive) setActive(null);
                        else setActive(room);
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
                        backgroundColor: `${room.color}${isActive ? '40' : sameName ? '25' : isHover ? '30' : '15'}`,
                        opacity: isHighlighted ? 1 : 0.25,
                        boxShadow: isActive ? `0 0 0 2px ${room.color}, 0 4px 12px rgba(0,0,0,.15)` : undefined,
                        cursor: room.room?.name ? 'pointer' : 'default',
                      }}
                      title={room.room?.name ?? room.label}
                    >
                      <span
                        className="absolute top-0 left-0 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white rounded-br-md"
                        style={{ backgroundColor: room.color }}
                      >
                        {room.room?.name ?? room.label}
                        {tipCount > 0 && (
                          <span className="ml-1 bg-white/30 px-1 rounded">{tipCount}</span>
                        )}
                      </span>
                    </button>

                    {/* Tooltip por hover do cômodo: imagens + totais pago/previsto */}
                    {isHover && agg && agg.items.length > 0 && (() => {
                      const cb = room._bounds;
                      const cx = cb.x + (cb.width ?? 0) / 2;
                      const placeTop = cb.y > 50;
                      const sample = agg.items.slice(0, 6);
                      const total = agg.pago + agg.planejado;
                      return (
                        <div
                          className="absolute z-30 pointer-events-none rounded-lg bg-white shadow-xl overflow-hidden w-[220px] border border-orange-200"
                          style={{
                            left: `${cx}%`,
                            transform: 'translateX(-50%)',
                            ...(placeTop
                              ? { top: `${cb.y - 1}%`, transformOrigin: 'center bottom' }
                              : { top: `${cb.y + (cb.height ?? 0) + 1}%`, transformOrigin: 'center top' }),
                            transition: 'opacity 120ms',
                          }}
                        >
                          <div className="px-2.5 py-1.5 bg-gradient-to-r from-orange-50 to-amber-50 border-b border-orange-100">
                            <p className="text-[11px] font-bold text-gray-800">{room.room?.name}</p>
                            <p className="text-[9px] text-gray-500">{agg.items.length} {agg.items.length === 1 ? 'item' : 'itens'}</p>
                          </div>
                          <div className="px-2.5 py-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
                            <span className="text-gray-500">Pago</span>
                            <span className="text-emerald-700 font-semibold text-right">{formatCurrency(agg.pago / 100)}</span>
                            <span className="text-gray-500">Previsto</span>
                            <span className="text-orange-700 font-semibold text-right">{formatCurrency(agg.planejado / 100)}</span>
                            <span className="text-gray-700 font-semibold border-t border-gray-100 pt-0.5">Total</span>
                            <span className="text-gray-900 font-bold text-right border-t border-gray-100 pt-0.5">{formatCurrency(total / 100)}</span>
                          </div>
                          {sample.length > 0 && (
                            <div className="px-2 pb-2 pt-1 flex gap-1 flex-wrap">
                              {sample.map((e) => (
                                <div key={e.id} className="w-12 h-12 bg-gray-50 rounded border border-gray-100 overflow-hidden flex items-center justify-center">
                                  <LinkPreviewImage
                                    imageUrl={e.imageUrl ?? null}
                                    link={e.link ?? null}
                                    alt={e.titulo ?? ''}
                                    className="max-w-full max-h-full object-contain"
                                  />
                                </div>
                              ))}
                              {agg.items.length > sample.length && (
                                <div className="w-12 h-12 bg-orange-50 rounded text-[10px] font-bold text-orange-600 flex items-center justify-center">
                                  +{agg.items.length - sample.length}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}

              {/* Marker pins */}
              {markers.map((marker) => {
                let mb: Bounds;
                try { mb = JSON.parse(marker.bounds); } catch { return null; }
                const cx = mb.x + (mb.width ?? 0) / 2;
                const cy = mb.y + (mb.height ?? 0) / 2;
                const e = marker.expense;
                const isHovered = hoveredMarker === marker.id;
                return (
                  <div
                    key={marker.id}
                    className="absolute group"
                    style={{
                      left: `${cx}%`,
                      top: `${cy}%`,
                      transform: 'translate(-50%, -100%)',
                      zIndex: isHovered ? 25 : 15,
                    }}
                    onMouseEnter={() => setHoveredMarker(marker.id)}
                    onMouseLeave={() => setHoveredMarker(null)}
                  >
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (e?.id) onFocusExpense(e.id);
                      }}
                      className="block"
                      title={e?.titulo ?? 'Item'}
                    >
                      <MapPin
                        className={`w-6 h-6 drop-shadow-md transition-transform ${isHovered ? 'scale-125' : ''}`}
                        style={{
                          color: isHovered ? '#FF6B00' : '#FF9100',
                          fill: isHovered ? '#FF6B00' : '#FF9100',
                          strokeWidth: 1.5,
                          stroke: '#ffffff',
                        }}
                      />
                    </button>
                    {isHovered && (
                      <div
                        className="absolute z-40 pointer-events-none rounded-lg bg-white shadow-lg overflow-hidden w-[140px] border border-orange-100"
                        style={{
                          left: '50%',
                          transform: 'translateX(-50%)',
                          ...(cy > 60 ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }),
                        }}
                      >
                        <div className="h-14 bg-gray-50 overflow-hidden flex items-center justify-center">
                          <LinkPreviewImage
                            imageUrl={e.imageUrl}
                            link={e.link}
                            alt={e.titulo ?? ''}
                            className="h-full w-full object-contain"
                          />
                        </div>
                        <div className="px-2 py-1.5">
                          <p className="text-[10px] font-bold text-gray-800 line-clamp-2 leading-tight">
                            {e.titulo ?? 'Sem título'}
                          </p>
                          <p className="text-[10px] font-bold text-orange-600 mt-0.5">
                            {formatCurrency(e.valorTotal / 100)}
                          </p>
                          <p className="text-[8px] text-gray-400 mt-0.5">Clique para ver o card →</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Hint */}
      <div className="px-3 py-1.5 bg-white/40 border-t border-orange-100 text-[10px] text-gray-500 flex items-center justify-between flex-wrap gap-1 lg:shrink-0">
        <span>💡 Use as <b>setas ← →</b> ou clique numa <b>área</b> para navegar · <b>Esc</b> limpa filtro</span>
        <span className="text-gray-400">{rooms.length} cômodos · {markers.length} pins</span>
      </div>
    </div>
  );
}
