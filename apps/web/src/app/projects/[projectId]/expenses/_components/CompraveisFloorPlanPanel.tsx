'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin, ChevronLeft, ChevronRight, Eye, EyeOff } from 'lucide-react';
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
  const [removeWhiteBg, setRemoveWhiteBg] = useState(true);
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const plan = floorPlans[selectedIdx];

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
    <div className="border border-orange-100 rounded-xl bg-gradient-to-br from-orange-50/40 to-amber-50/40 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-white/60 border-b border-orange-100">
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
          {filterAmbiente && (
            <button
              onClick={() => onFilterAmbiente(null)}
              className="text-[10px] bg-orange-500 text-white px-2 py-0.5 rounded-full hover:bg-orange-600"
            >
              Limpar filtro: {filterAmbiente} ✕
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
      <div className="relative bg-[linear-gradient(45deg,#fff8f0_25%,transparent_25%,transparent_75%,#fff8f0_75%),linear-gradient(45deg,#fff8f0_25%,transparent_25%,transparent_75%,#fff8f0_75%)] bg-[length:16px_16px] bg-[position:0_0,8px_8px]">
        <div className="relative w-full max-h-[42vh] flex items-center justify-center overflow-hidden">
          {plan?.imageUrl && (
            <div className="relative inline-block max-h-[42vh]">
              <img
                src={`${API_BASE}${plan.imageUrl}`}
                alt={plan.name}
                className="max-h-[42vh] max-w-full block"
                style={removeWhiteBg ? { mixBlendMode: 'multiply' } : undefined}
              />

              {/* Room areas */}
              {parsedRooms.map((room) => {
                const isSelected = filterAmbiente && room.room?.name === filterAmbiente;
                const isHighlighted = filterAmbiente
                  ? room.room?.name === filterAmbiente
                  : true;
                return (
                  <div key={room.id}>
                    <button
                      onClick={() => onFilterAmbiente(
                        filterAmbiente === room.room?.name ? null : (room.room?.name ?? null),
                      )}
                      disabled={!room.room?.name}
                      className="absolute border-2 transition-all"
                      style={{
                        left: `${room._bounds.x}%`,
                        top: `${room._bounds.y}%`,
                        width: `${room._bounds.width ?? 0}%`,
                        height: `${room._bounds.height ?? 0}%`,
                        borderColor: room.color,
                        backgroundColor: `${room.color}${isSelected ? '40' : '15'}`,
                        opacity: isHighlighted ? 1 : 0.25,
                        boxShadow: isSelected ? `0 0 0 2px ${room.color}, 0 4px 12px rgba(0,0,0,.15)` : undefined,
                        cursor: room.room?.name ? 'pointer' : 'default',
                      }}
                      title={room.room?.name ?? room.label}
                    >
                      <span
                        className="absolute top-0 left-0 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white rounded-br-md"
                        style={{ backgroundColor: room.color }}
                      >
                        {room.room?.name ?? room.label}
                      </span>
                    </button>
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
                        {e.imageUrl && (
                          <div className="h-14 bg-gray-50 overflow-hidden flex items-center justify-center">
                            <img src={e.imageUrl} alt={e.titulo ?? ''} className="h-full w-full object-contain" />
                          </div>
                        )}
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
      <div className="px-3 py-1.5 bg-white/40 border-t border-orange-100 text-[10px] text-gray-500 flex items-center justify-between flex-wrap gap-1">
        <span>💡 Clique numa <b>área</b> para filtrar pelo cômodo · clique num <b>pin</b> para ir até o item</span>
        <span className="text-gray-400">{rooms.length} cômodos · {markers.length} pins</span>
      </div>
    </div>
  );
}
