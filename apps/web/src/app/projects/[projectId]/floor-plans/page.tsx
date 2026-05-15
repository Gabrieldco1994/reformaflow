'use client';
import { useProject } from '@/contexts/project-context';

import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  Upload,
  Trash2,
  RefreshCw,
  Plus,
  X,
  ChevronLeft,
  Eye,
  Edit3,
  Image as ImageIcon,
  Map as MapIcon,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from 'lucide-react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ─── Types ──────────────────────────────────────────────────

interface FloorPlanRoom {
  id: string;
  floorPlanId: string;
  roomId: string | null;
  label: string;
  bounds: string; // JSON {x, y, width, height}
  color: string;
  room?: {
    id: string;
    name: string;
    expenses?: { id: string; titulo: string; valorTotal: number; status: string; tipoDespesa: string }[];
    roomImages?: { id: string; imageUrl: string; caption?: string }[];
  };
}

interface FloorPlan {
  id: string;
  name: string;
  imageUrl: string;
  rooms: FloorPlanRoom[];
  createdAt: string;
}

interface Room {
  id: string;
  name: string;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  area?: number;
  sqft?: number;
  dimensions?: { width?: number; depth?: number; units?: string };
  elements?: string[];
}

// ─── Room Detail Panel ──────────────────────────────────────

function RoomDetailPanel({
  room,
  onClose,
  onUploadImage,
  onDeleteImage,
}: {
  room: FloorPlanRoom;
  onClose: () => void;
  onUploadImage: (roomId: string, file: File) => void;
  onDeleteImage: (imageId: string) => void;
}) {
  const expenses = room.room?.expenses || [];
  const images = room.room?.roomImages || [];
  const totalPago = expenses.filter((e) => e.status === 'PAGO').reduce((s, e) => s + e.valorTotal, 0);
  const totalPlanejado = expenses.filter((e) => e.status === 'PLANEJADO').reduce((s, e) => s + e.valorTotal, 0);
  const bounds: Bounds = JSON.parse(room.bounds);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="absolute right-0 top-0 h-full w-80 bg-white shadow-xl border-l z-50 overflow-y-auto">
      <div className="p-4 border-b flex items-center justify-between" style={{ borderLeftColor: room.color, borderLeftWidth: 4 }}>
        <div>
          <h3 className="font-bold text-lg">{room.label}</h3>
          {bounds.area && <p className="text-sm text-gray-500">{bounds.area} m² {bounds.sqft ? `(${bounds.sqft} sqft)` : ''}</p>}
          {bounds.dimensions && (
            <p className="text-xs text-gray-400">
              {bounds.dimensions.width} × {bounds.dimensions.depth} {bounds.dimensions.units || 'm'}
            </p>
          )}
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
      </div>

      {/* Despesas */}
      <div className="p-4 border-b">
        <h4 className="font-semibold text-sm text-gray-700 mb-2">💰 Despesas</h4>
        {expenses.length === 0 ? (
          <p className="text-sm text-gray-400">Nenhuma despesa vinculada</p>
        ) : (
          <>
            <div className="flex gap-3 mb-3">
              <div className="flex-1 bg-green-50 rounded-lg p-2 text-center">
                <p className="text-xs text-green-600">Pago</p>
                <p className="font-bold text-green-700">R$ {(totalPago / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
              </div>
              <div className="flex-1 bg-yellow-50 rounded-lg p-2 text-center">
                <p className="text-xs text-yellow-600">Planejado</p>
                <p className="font-bold text-yellow-700">R$ {(totalPlanejado / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
              </div>
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {expenses.map((e) => (
                <div key={e.id} className="flex justify-between text-xs p-1.5 bg-gray-50 rounded">
                  <span className="truncate flex-1">{e.titulo || e.tipoDespesa}</span>
                  <span className={`font-medium ${e.status === 'PAGO' ? 'text-green-600' : 'text-yellow-600'}`}>
                    R$ {(e.valorTotal / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Elementos detectados */}
      {bounds.elements && bounds.elements.length > 0 && (
        <div className="px-4 pb-3 border-b">
          <h4 className="font-semibold text-sm text-gray-700 mb-2">🏠 Elementos</h4>
          <div className="flex flex-wrap gap-1">
            {bounds.elements.map((el, i) => (
              <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">{el}</span>
            ))}
          </div>
        </div>
      )}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold text-sm text-gray-700">📷 Imagens do Projeto</h4>
          {room.room && (
            <button
              onClick={() => fileRef.current?.click()}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Adicionar
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && room.room) onUploadImage(room.room.id, f);
            e.target.value = '';
          }}
        />
        {images.length === 0 ? (
          <p className="text-sm text-gray-400">Nenhuma imagem</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {images.map((img) => (
              <div key={img.id} className="relative group">
                <img
                  src={`${API_BASE}${img.imageUrl}`}
                  alt={img.caption || ''}
                  className="w-full h-24 object-cover rounded-lg"
                />
                <button
                  onClick={() => onDeleteImage(img.id)}
                  className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Floor Plan Viewer ──────────────────────────────────────

function FloorPlanViewer({
  floorPlan,
  rooms: projectRooms,
  onBack,
  onRefresh,
}: {
  floorPlan: FloorPlan;
  rooms: Room[];
  onBack: () => void;
  onRefresh: () => void;
}) {
  const { projectId: PROJECT_ID } = useProject();
  const [selectedRoom, setSelectedRoom] = useState<FloorPlanRoom | null>(null);
  const [drawingMode, setDrawingMode] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [hoveredRoom, setHoveredRoom] = useState<string | null>(null);
  const imageRef = useRef<HTMLDivElement>(null);

  const handleReanalyze = async () => {
    setReanalyzing(true);
    try {
      await api.post(`/projects/${PROJECT_ID}/floor-plans/${floorPlan.id}/reanalyze`, {});
      onRefresh();
    } catch (err) {
      console.error(err);
    } finally {
      setReanalyzing(false);
    }
  };

  const getMousePercent = (e: React.MouseEvent) => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!drawingMode) return;
    e.preventDefault();
    setDrawStart(getMousePercent(e));
    setDrawCurrent(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drawingMode || !drawStart) return;
    setDrawCurrent(getMousePercent(e));
  };

  const handleMouseUp = async () => {
    if (!drawingMode || !drawStart || !drawCurrent) return;
    const bounds: Bounds = {
      x: Math.min(drawStart.x, drawCurrent.x),
      y: Math.min(drawStart.y, drawCurrent.y),
      width: Math.abs(drawCurrent.x - drawStart.x),
      height: Math.abs(drawCurrent.y - drawStart.y),
    };
    if (bounds.width < 2 || bounds.height < 2) {
      setDrawStart(null);
      setDrawCurrent(null);
      return;
    }
    const label = prompt('Nome do cômodo:');
    if (!label) {
      setDrawStart(null);
      setDrawCurrent(null);
      return;
    }
    try {
      await api.post(`/projects/${PROJECT_ID}/floor-plans/${floorPlan.id}/rooms`, {
        label,
        bounds: JSON.stringify(bounds),
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
      });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
    setDrawStart(null);
    setDrawCurrent(null);
    setDrawingMode(false);
  };

  const handleDeleteRoom = async (roomId: string) => {
    if (!confirm('Remover esta marcação?')) return;
    await api.delete(`/projects/${PROJECT_ID}/floor-plans/rooms/${roomId}`);
    if (selectedRoom?.id === roomId) setSelectedRoom(null);
    onRefresh();
  };

  const handleLinkRoom = async (markerId: string, roomId: string | null) => {
    await api.patch(`/projects/${PROJECT_ID}/floor-plans/rooms/${markerId}`, { roomId });
    onRefresh();
  };

  const handleUploadImage = async (roomId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    await api.upload(`/projects/${PROJECT_ID}/floor-plans/room-images/${roomId}`, fd);
    onRefresh();
  };

  const handleDeleteImage = async (imageId: string) => {
    await api.delete(`/projects/${PROJECT_ID}/floor-plans/room-images/image/${imageId}`);
    onRefresh();
  };

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900">
          <ChevronLeft className="w-4 h-4" /> Voltar
        </button>
        <h2 className="text-lg font-bold flex-1 truncate">{floorPlan.name}</h2>
        <button
          onClick={() => setDrawingMode(!drawingMode)}
          className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1 ${
            drawingMode ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          <Edit3 className="w-4 h-4" /> {drawingMode ? 'Desenhando...' : 'Marcar Cômodo'}
        </button>
        <button
          onClick={handleReanalyze}
          disabled={reanalyzing}
          className="px-3 py-1.5 rounded-lg text-sm bg-purple-100 text-purple-700 hover:bg-purple-200 flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${reanalyzing ? 'animate-spin' : ''}`} /> IA Detectar
        </button>
        <span className="text-xs text-gray-400">{floorPlan.rooms.length} cômodos</span>
      </div>

      {/* Main content */}
      <div className="flex-1 relative bg-gray-100 rounded-xl overflow-hidden min-h-0">
        <TransformWrapper
          disabled={drawingMode}
          minScale={0.5}
          maxScale={4}
          centerOnInit
        >
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <div className="absolute top-3 left-3 z-30 flex flex-col gap-1">
                <button onClick={() => zoomIn()} className="p-1.5 bg-white rounded-lg shadow hover:bg-gray-50">
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button onClick={() => zoomOut()} className="p-1.5 bg-white rounded-lg shadow hover:bg-gray-50">
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button onClick={() => resetTransform()} className="p-1.5 bg-white rounded-lg shadow hover:bg-gray-50">
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>

              <TransformComponent wrapperClass="!w-full !h-full" contentClass="!w-full !h-full flex items-center justify-center">
                <div
                  ref={imageRef}
                  className="relative inline-block"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  style={{ cursor: drawingMode ? 'crosshair' : 'grab' }}
                >
                  <img
                    src={`${API_BASE}${floorPlan.imageUrl}`}
                    alt={floorPlan.name}
                    className="max-w-full max-h-[75vh] select-none"
                    draggable={false}
                  />

                  {/* Room overlays */}
                  {floorPlan.rooms.map((room) => {
                    const b: Bounds = JSON.parse(room.bounds);
                    const isHovered = hoveredRoom === room.id;
                    const isSelected = selectedRoom?.id === room.id;
                    return (
                      <div
                        key={room.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRoom(isSelected ? null : room);
                        }}
                        onMouseEnter={() => setHoveredRoom(room.id)}
                        onMouseLeave={() => setHoveredRoom(null)}
                        className="absolute transition-all duration-150 cursor-pointer"
                        style={{
                          left: `${b.x}%`,
                          top: `${b.y}%`,
                          width: `${b.width}%`,
                          height: `${b.height}%`,
                          backgroundColor: `${room.color}${isHovered || isSelected ? '40' : '20'}`,
                          border: `2px solid ${room.color}${isHovered || isSelected ? 'FF' : '80'}`,
                          borderRadius: 4,
                        }}
                      >
                        <div
                          className="absolute left-0 px-1.5 py-0.5 rounded text-[10px] font-bold text-white whitespace-nowrap flex items-center gap-1"
                          style={{
                            backgroundColor: room.color,
                            ...(b.y < 5 ? { bottom: -20 } : { top: -20 }),
                          }}
                        >
                          {room.label}
                          {room.room && <span className="opacity-70">✓</span>}
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteRoom(room.id); }}
                            className="ml-1 hover:bg-white/20 rounded p-0.5"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                        {b.area && (
                          <div className="absolute bottom-0.5 right-1 text-[9px] font-medium" style={{ color: room.color }}>
                            {b.area}m²
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Drawing preview */}
                  {drawStart && drawCurrent && (
                    <div
                      className="absolute border-2 border-dashed border-blue-500 bg-blue-200/30 pointer-events-none"
                      style={{
                        left: `${Math.min(drawStart.x, drawCurrent.x)}%`,
                        top: `${Math.min(drawStart.y, drawCurrent.y)}%`,
                        width: `${Math.abs(drawCurrent.x - drawStart.x)}%`,
                        height: `${Math.abs(drawCurrent.y - drawStart.y)}%`,
                      }}
                    />
                  )}
                </div>
              </TransformComponent>
            </>
          )}
        </TransformWrapper>

        {/* Room list sidebar */}
        {floorPlan.rooms.length > 0 && !selectedRoom && (
          <div className="absolute right-3 top-3 w-52 bg-white/95 backdrop-blur rounded-xl shadow-lg p-3 z-20 max-h-[60vh] overflow-y-auto">
            <h4 className="text-xs font-bold text-gray-500 mb-2 uppercase">Cômodos</h4>
            {floorPlan.rooms.map((room) => (
              <div
                key={room.id}
                className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-gray-50 cursor-pointer text-sm"
                onClick={() => setSelectedRoom(room)}
                onMouseEnter={() => setHoveredRoom(room.id)}
                onMouseLeave={() => setHoveredRoom(null)}
              >
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: room.color }} />
                <span className="flex-1 truncate">{room.label}</span>
                {!room.roomId && (
                  <select
                    className="text-xs border rounded px-1 py-0.5 max-w-[80px]"
                    value=""
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => handleLinkRoom(room.id, e.target.value || null)}
                  >
                    <option value="">Vincular</option>
                    {projectRooms.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                )}
                {room.roomId && <span className="text-green-500 text-xs">✓</span>}
              </div>
            ))}
          </div>
        )}

        {/* Selected room detail */}
        {selectedRoom && (
          <RoomDetailPanel
            room={selectedRoom}
            onClose={() => setSelectedRoom(null)}
            onUploadImage={handleUploadImage}
            onDeleteImage={handleDeleteImage}
          />
        )}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────

export default function FloorPlansPage() {
  const { projectId: PROJECT_ID } = useProject();
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [fps, rs] = await Promise.all([
        api.get<FloorPlan[]>(`/projects/${PROJECT_ID}/floor-plans`),
        api.get<Room[]>(`/projects/${PROJECT_ID}`).then((p: any) => p.rooms || []).catch(() => []),
      ]);
      setFloorPlans(fps);
      setRooms(rs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', file.name.replace(/\.[^.]+$/, ''));
      const fp = await api.upload<FloorPlan>(`/projects/${PROJECT_ID}/floor-plans`, fd);
      // Wait a bit for Gemini analysis
      setTimeout(() => load(), 5000);
      setSelectedId(fp.id);
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Excluir esta planta?')) return;
    await api.delete(`/projects/${PROJECT_ID}/floor-plans/${id}`);
    if (selectedId === id) setSelectedId(null);
    load();
  };

  const selected = floorPlans.find((fp) => fp.id === selectedId);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (selected) {
    return (
      <FloorPlanViewer
        floorPlan={selected}
        rooms={rooms}
        onBack={() => setSelectedId(null)}
        onRefresh={() => load()}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🏗️ Plantas Baixas</h1>
          <p className="text-sm text-gray-500 mt-1">
            Faça upload das plantas do projeto. A IA identifica os cômodos automaticamente.
          </p>
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 flex items-center gap-2 disabled:opacity-50"
        >
          {uploading ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          {uploading ? 'Enviando...' : 'Upload Planta'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
            e.target.value = '';
          }}
        />
      </div>

      {floorPlans.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <MapIcon className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p className="text-lg">Nenhuma planta cadastrada</p>
          <p className="text-sm mt-1">Faça upload de uma planta baixa para começar</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {floorPlans.map((fp) => (
            <div
              key={fp.id}
              className="bg-white rounded-xl border shadow-sm overflow-hidden hover:shadow-md transition-shadow cursor-pointer group"
              onClick={() => setSelectedId(fp.id)}
            >
              <div className="relative h-48 bg-gray-100">
                <img
                  src={`${API_BASE}${fp.imageUrl}`}
                  alt={fp.name}
                  className="w-full h-full object-contain"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                  <Eye className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" />
                </div>
              </div>
              <div className="p-3 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-sm">{fp.name}</h3>
                  <p className="text-xs text-gray-400">{fp.rooms.length} cômodos detectados</p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(fp.id); }}
                  className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
