'use client';

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  MapPin, ChevronLeft, ChevronRight, Eye, EyeOff, X, Maximize2, Minimize2,
  Home, ArrowLeft, ArrowRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';
import { formatCurrency } from '@/lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface FloorPlanRoom {
  id: string;
  floorPlanId: string;
  roomId: string | null;
  label: string;
  bounds: string;
  color: string;
  room?: {
    id: string;
    name: string;
    expenses?: { id: string; valorTotal: number; status: string }[];
  };
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
    fornecedor: string | null;
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

function parseBounds(s: string): Bounds | null {
  try { return JSON.parse(s); } catch { return null; }
}

export function CompraveisFloorPlanPanel({
  filterAmbiente,
  onFilterAmbiente,
  onFocusExpense,
}: {
  filterAmbiente: string | null;
  onFilterAmbiente: (name: string | null) => void;
  onFocusExpense: (expenseId: string) => void;
}) {
  const { projectId: PROJECT_ID } = useProject();
  const { data: floorPlans = [] } = useQuery<FloorPlan[]>({
    queryKey: ['floor-plans', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/floor-plans`),
  });

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [blueprintMode, setBlueprintMode] = useState(true);
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const plan = floorPlans[selectedIdx];

  useEffect(() => {
    if (selectedIdx >= floorPlans.length) setSelectedIdx(0);
  }, [floorPlans.length, selectedIdx]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('compraveis-floorplan-prefs-v2');
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p.collapsed === 'boolean') setCollapsed(p.collapsed);
        if (typeof p.blueprintMode === 'boolean') setBlueprintMode(p.blueprintMode);
        if (typeof p.expanded === 'boolean') setExpanded(p.expanded);
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('compraveis-floorplan-prefs-v2', JSON.stringify({ collapsed, blueprintMode, expanded }));
    } catch { /* ignore */ }
  }, [collapsed, blueprintMode, expanded]);

  const rooms = plan?.rooms ?? [];
  const markers = plan?.markers ?? [];

  const parsedRooms = useMemo(() => rooms.map((r) => {
    const b = parseBounds(r.bounds);
    return b ? { ...r, _bounds: b } : null;
  }).filter(Boolean) as (FloorPlanRoom & { _bounds: Bounds })[], [rooms]);

  // Lista ordenada pra navegação
  const navRooms = useMemo(
    () => parsedRooms.filter((r) => r.room?.name).sort((a, b) => (a.room!.name).localeCompare(b.room!.name)),
    [parsedRooms],
  );

  const activeRoom = useMemo(() => {
    if (!filterAmbiente) return null;
    return navRooms.find((r) => r.room?.name === filterAmbiente) ?? null;
  }, [filterAmbiente, navRooms]);

  const goPrev = useCallback(() => {
    if (navRooms.length === 0) return;
    if (!activeRoom) { onFilterAmbiente(navRooms[0].room!.name); return; }
    const i = navRooms.findIndex((r) => r.id === activeRoom.id);
    const prev = navRooms[(i - 1 + navRooms.length) % navRooms.length];
    onFilterAmbiente(prev.room!.name);
  }, [navRooms, activeRoom, onFilterAmbiente]);

  const goNext = useCallback(() => {
    if (navRooms.length === 0) return;
    if (!activeRoom) { onFilterAmbiente(navRooms[0].room!.name); return; }
    const i = navRooms.findIndex((r) => r.id === activeRoom.id);
    const next = navRooms[(i + 1) % navRooms.length];
    onFilterAmbiente(next.room!.name);
  }, [navRooms, activeRoom, onFilterAmbiente]);

  // Keyboard navigation
  useEffect(() => {
    if (collapsed) return;
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'Escape' && activeRoom) { e.preventDefault(); onFilterAmbiente(null); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [goPrev, goNext, activeRoom, collapsed, onFilterAmbiente]);

  // Zoom transform on active room
  const zoomStyle = useMemo<React.CSSProperties>(() => {
    if (!activeRoom) return { transform: 'scale(1) translate(0, 0)', transformOrigin: 'center' };
    const b = activeRoom._bounds;
    const cx = b.x + (b.width ?? 0) / 2;
    const cy = b.y + (b.height ?? 0) / 2;
    // Calcula zoom para o cômodo preencher ~70% da view
    const targetSize = 65;
    const roomMax = Math.max(b.width ?? 30, b.height ?? 30);
    const zoom = Math.min(2.4, Math.max(1.4, targetSize / roomMax));
    return {
      transform: `scale(${zoom})`,
      transformOrigin: `${cx}% ${cy}%`,
      transition: 'transform 700ms cubic-bezier(.22,1,.36,1)',
    };
  }, [activeRoom]);

  if (floorPlans.length === 0) return null;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-full flex items-center justify-center gap-2 py-2.5 text-xs font-mono font-medium text-cyan-300 bg-slate-900 border border-cyan-500/30 rounded-xl hover:bg-slate-800 hover:border-cyan-400/50 transition-all shadow-lg shadow-cyan-500/10"
      >
        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
        <MapPin className="w-3.5 h-3.5 text-cyan-400" />
        <span className="tracking-wider">ABRIR PLANTA · {rooms.length} CÔMODOS · {markers.length} OBJETOS</span>
      </button>
    );
  }

  const containerHeight = expanded ? 'h-[80vh]' : 'h-[60vh] sm:h-[65vh]';

  return (
    <div className={`relative rounded-xl overflow-hidden bg-slate-950 border border-cyan-500/20 shadow-2xl shadow-cyan-500/5 ${containerHeight} flex flex-col`}>
      {/* HUD Header */}
      <div className="relative z-30 flex items-center justify-between px-3 py-2 bg-gradient-to-r from-slate-950/95 via-slate-900/95 to-slate-950/95 border-b border-cyan-500/30 backdrop-blur">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
            <span className="text-[10px] font-mono font-bold text-cyan-300 tracking-[0.2em]">PLANTA</span>
          </div>
          <span className="text-cyan-500/40 text-xs">·</span>
          <span className="text-xs font-mono text-cyan-100 truncate max-w-[150px]">{plan?.name ?? '—'}</span>
          {floorPlans.length > 1 && (
            <div className="flex items-center gap-1 ml-1">
              <button
                onClick={() => setSelectedIdx((i) => (i - 1 + floorPlans.length) % floorPlans.length)}
                className="p-0.5 rounded hover:bg-cyan-500/20 text-cyan-400"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] font-mono text-cyan-300">{selectedIdx + 1}/{floorPlans.length}</span>
              <button
                onClick={() => setSelectedIdx((i) => (i + 1) % floorPlans.length)}
                className="p-0.5 rounded hover:bg-cyan-500/20 text-cyan-400"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setBlueprintMode((v) => !v)}
            className={`p-1.5 rounded transition-colors text-[10px] font-mono font-bold tracking-wider ${blueprintMode ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
            title="Modo blueprint"
          >
            {blueprintMode ? 'BLUEPRINT' : 'ORIGINAL'}
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1.5 rounded hover:bg-cyan-500/20 text-cyan-400"
            title={expanded ? 'Reduzir' : 'Expandir'}
          >
            {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-300"
            title="Fechar"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Breadcrumb / room nav */}
      <div className="relative z-30 flex items-center justify-between px-3 py-1.5 bg-slate-900/80 border-b border-cyan-500/20 backdrop-blur">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => onFilterAmbiente(null)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] tracking-wider transition-colors ${
              activeRoom ? 'text-cyan-400 hover:bg-cyan-500/10' : 'text-cyan-300 bg-cyan-500/15'
            }`}
          >
            <Home className="w-3 h-3" />
            VISÃO GERAL
          </button>
          {activeRoom && (
            <>
              <span className="text-cyan-500/40 text-xs">›</span>
              <span
                className="px-2 py-0.5 rounded font-mono text-[11px] font-bold tracking-wider"
                style={{
                  color: activeRoom.color,
                  backgroundColor: `${activeRoom.color}25`,
                  boxShadow: `0 0 12px ${activeRoom.color}40`,
                }}
              >
                {activeRoom.room?.name?.toUpperCase()}
              </span>
            </>
          )}
        </div>
        {navRooms.length > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={goPrev} className="p-1 rounded hover:bg-cyan-500/15 text-cyan-300" title="← Anterior">
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[9px] font-mono text-cyan-500/60 tracking-wider">
              {activeRoom ? `${navRooms.findIndex((r) => r.id === activeRoom.id) + 1}/${navRooms.length}` : `0/${navRooms.length}`}
            </span>
            <button onClick={goNext} className="p-1 rounded hover:bg-cyan-500/15 text-cyan-300" title="Próximo →">
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Floor plan canvas */}
      <div
        className="relative flex-1 overflow-hidden"
        style={{
          backgroundImage: `
            linear-gradient(rgba(34,211,238,.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(34,211,238,.06) 1px, transparent 1px),
            radial-gradient(circle at 50% 50%, rgba(34,211,238,.08) 0%, transparent 70%)
          `,
          backgroundSize: '32px 32px, 32px 32px, 100% 100%',
        }}
      >
        {/* Scanline effect */}
        <div className="absolute inset-0 pointer-events-none z-10 opacity-30"
          style={{
            background: 'repeating-linear-gradient(0deg, rgba(34,211,238,.05) 0px, rgba(34,211,238,.05) 1px, transparent 1px, transparent 4px)',
          }}
        />
        {/* Corner brackets */}
        <div className="absolute top-2 left-2 w-5 h-5 border-l-2 border-t-2 border-cyan-400/40 z-10" />
        <div className="absolute top-2 right-2 w-5 h-5 border-r-2 border-t-2 border-cyan-400/40 z-10" />
        <div className="absolute bottom-2 left-2 w-5 h-5 border-l-2 border-b-2 border-cyan-400/40 z-10" />
        <div className="absolute bottom-2 right-2 w-5 h-5 border-r-2 border-b-2 border-cyan-400/40 z-10" />

        <div className="w-full h-full flex items-center justify-center p-4">
          <div className="relative inline-block max-h-full max-w-full" style={zoomStyle}>
            {plan?.imageUrl && (
              <img
                src={`${API_BASE}${plan.imageUrl}`}
                alt={plan.name}
                className="block max-h-[58vh] max-w-full select-none"
                draggable={false}
                style={
                  blueprintMode
                    ? { filter: 'invert(1) hue-rotate(180deg) brightness(1.15) contrast(1.1) saturate(.8)' }
                    : undefined
                }
              />
            )}

            {/* Room areas overlay */}
            {parsedRooms.map((room) => {
              const isActive = activeRoom?.id === room.id;
              const isHovered = hoveredRoomId === room.id;
              const dim = !!activeRoom && !isActive;
              const expCount = room.room?.expenses?.filter((e) => !!e).length ?? 0;
              const expTotal = room.room?.expenses?.reduce((s, e) => s + e.valorTotal, 0) ?? 0;
              return (
                <button
                  key={room.id}
                  onClick={() => onFilterAmbiente(isActive ? null : (room.room?.name ?? null))}
                  onMouseEnter={() => setHoveredRoomId(room.id)}
                  onMouseLeave={() => setHoveredRoomId(null)}
                  disabled={!room.room?.name}
                  className="absolute group"
                  style={{
                    left: `${room._bounds.x}%`,
                    top: `${room._bounds.y}%`,
                    width: `${room._bounds.width ?? 0}%`,
                    height: `${room._bounds.height ?? 0}%`,
                    cursor: room.room?.name ? 'pointer' : 'default',
                    opacity: dim ? 0.18 : 1,
                    transition: 'opacity 300ms ease',
                  }}
                  title={room.room?.name ?? room.label}
                >
                  <div
                    className="absolute inset-0 transition-all"
                    style={{
                      border: `2px solid ${room.color}`,
                      backgroundColor: isActive ? `${room.color}30` : isHovered ? `${room.color}20` : `${room.color}08`,
                      boxShadow: isActive
                        ? `0 0 24px ${room.color}, inset 0 0 24px ${room.color}40`
                        : isHovered
                          ? `0 0 12px ${room.color}80`
                          : `0 0 4px ${room.color}40`,
                    }}
                  />
                  {/* Corner accents */}
                  <span className="absolute top-0 left-0 w-2 h-2 border-l-2 border-t-2" style={{ borderColor: room.color }} />
                  <span className="absolute top-0 right-0 w-2 h-2 border-r-2 border-t-2" style={{ borderColor: room.color }} />
                  <span className="absolute bottom-0 left-0 w-2 h-2 border-l-2 border-b-2" style={{ borderColor: room.color }} />
                  <span className="absolute bottom-0 right-0 w-2 h-2 border-r-2 border-b-2" style={{ borderColor: room.color }} />
                  {/* Label */}
                  <span
                    className="absolute top-1 left-1 px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-wider rounded backdrop-blur-sm whitespace-nowrap"
                    style={{
                      color: room.color,
                      backgroundColor: 'rgba(2,6,23,0.85)',
                      border: `1px solid ${room.color}80`,
                      textShadow: `0 0 6px ${room.color}`,
                    }}
                  >
                    {room.room?.name ?? room.label}
                    {expCount > 0 && <span className="ml-1 text-cyan-300/80">· {expCount}</span>}
                  </span>
                  {/* Tooltip on hover */}
                  {isHovered && !isActive && room.room?.name && (
                    <div
                      className="absolute z-30 left-1/2 -translate-x-1/2 bottom-full mb-1.5 px-2 py-1 rounded bg-slate-950 border whitespace-nowrap text-[10px] font-mono pointer-events-none"
                      style={{ borderColor: `${room.color}60` }}
                    >
                      <div className="font-bold" style={{ color: room.color }}>{room.room.name}</div>
                      <div className="text-cyan-300/80">{expCount} {expCount === 1 ? 'item' : 'itens'} · {formatCurrency(expTotal / 100)}</div>
                    </div>
                  )}
                </button>
              );
            })}

            {/* Marker pins */}
            {markers.map((marker) => {
              const mb = parseBounds(marker.bounds);
              if (!mb) return null;
              const cx = mb.x + (mb.width ?? 0) / 2;
              const cy = mb.y + (mb.height ?? 0) / 2;
              const e = marker.expense;
              const isHovered = hoveredMarker === marker.id;
              return (
                <div
                  key={marker.id}
                  className="absolute"
                  style={{
                    left: `${cx}%`,
                    top: `${cy}%`,
                    transform: 'translate(-50%, -50%)',
                    zIndex: isHovered ? 28 : 18,
                  }}
                  onMouseEnter={() => setHoveredMarker(marker.id)}
                  onMouseLeave={() => setHoveredMarker(null)}
                >
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (e?.id) onFocusExpense(e.id);
                    }}
                    className="relative block"
                    title={e?.titulo ?? 'Item'}
                  >
                    {/* Pulsing ring */}
                    <span className="absolute inset-0 -m-2 rounded-full bg-cyan-400/30 animate-ping" />
                    <span className="absolute inset-0 -m-1 rounded-full bg-cyan-400/40" />
                    <span className="relative block w-3 h-3 rounded-full bg-cyan-400 border-2 border-white shadow-[0_0_12px_rgba(34,211,238,1)]" />
                  </button>
                  {isHovered && (
                    <div
                      className="absolute z-40 pointer-events-none rounded-lg bg-slate-950/95 border border-cyan-400/60 shadow-[0_0_24px_rgba(34,211,238,.4)] overflow-hidden w-[160px] backdrop-blur"
                      style={{
                        left: '50%',
                        transform: 'translateX(-50%)',
                        ...(cy > 55 ? { bottom: 'calc(100% + 10px)' } : { top: 'calc(100% + 10px)' }),
                      }}
                    >
                      {e.imageUrl && (
                        <div className="h-16 bg-slate-900 overflow-hidden flex items-center justify-center">
                          <img src={e.imageUrl} alt={e.titulo ?? ''} className="h-full w-full object-contain" />
                        </div>
                      )}
                      <div className="px-2 py-1.5">
                        <p className="text-[10px] font-bold text-cyan-100 line-clamp-2 leading-tight">
                          {e.titulo ?? 'Sem título'}
                        </p>
                        {e.fornecedor && <p className="text-[9px] text-cyan-300/60 mt-0.5 truncate">{e.fornecedor}</p>}
                        <p className="text-[11px] font-bold text-cyan-300 mt-0.5">
                          {formatCurrency(e.valorTotal / 100)}
                        </p>
                        <p className="text-[8px] font-mono text-cyan-500/60 mt-0.5 tracking-wider">→ VER CARD</p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* HUD Footer */}
      <div className="relative z-30 flex items-center justify-between px-3 py-1.5 bg-slate-950/95 border-t border-cyan-500/30 text-[10px] font-mono text-cyan-400/80 tracking-wider backdrop-blur">
        <div className="flex items-center gap-3">
          <span>◆ {rooms.length} CÔMODOS</span>
          <span className="text-cyan-500/30">·</span>
          <span>● {markers.length} OBJETOS</span>
        </div>
        <div className="hidden sm:flex items-center gap-2 text-cyan-500/50">
          <span>← → NAVEGAR</span>
          <span className="text-cyan-500/30">·</span>
          <span>ESC LIMPAR</span>
          <span className="text-cyan-500/30">·</span>
          <span>CLICK NO PIN PARA O CARD</span>
        </div>
      </div>
    </div>
  );
}
