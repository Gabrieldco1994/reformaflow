'use client';
import { useProject } from '@/contexts/project-context';

import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { compressImage } from '@/lib/image-compress';
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

const BRL = (centavos: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100);

function summarizeRoom(room: FloorPlanRoom) {
  const expenses = room.room?.expenses ?? [];
  const images = room.room?.roomImages ?? [];
  const pago = expenses.filter((e) => e.status === 'PAGO').reduce((s, e) => s + e.valorTotal, 0);
  const planejado = expenses
    .filter((e) => e.status === 'PLANEJADO')
    .reduce((s, e) => s + e.valorTotal, 0);
  return { expenses, images, pago, planejado, total: pago + planejado };
}

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
  projectRooms,
  onClose,
  onUploadImage,
  onDeleteImage,
  onLinkRoom,
  uploading,
  uploadError,
  onDismissUploadError,
}: {
  room: FloorPlanRoom;
  projectRooms: Room[];
  onClose: () => void;
  onUploadImage: (roomId: string, file: File) => void;
  onDeleteImage: (imageId: string) => void;
  onLinkRoom: (markerId: string, roomId: string | null) => void;
  uploading: boolean;
  uploadError: string | null;
  onDismissUploadError: () => void;
}) {
  const expenses = room.room?.expenses || [];
  const images = room.room?.roomImages || [];
  const totalPago = expenses.filter((e) => e.status === 'PAGO').reduce((s, e) => s + e.valorTotal, 0);
  const totalPlanejado = expenses.filter((e) => e.status === 'PLANEJADO').reduce((s, e) => s + e.valorTotal, 0);
  const bounds: Bounds = JSON.parse(room.bounds);
  const fileRef = useRef<HTMLInputElement>(null);
  const isLinked = !!room.room;

  return (
    <div className="absolute right-0 top-0 h-full w-80 bg-white shadow-xl border-l z-50 overflow-y-auto">
      <div className="p-4 border-b flex items-center justify-between" style={{ borderLeftColor: room.color, borderLeftWidth: 4 }}>
        <div>
          <h3 className="font-bold text-lg">{room.label}</h3>
          {room.room && room.room.name !== room.label && (
            <p className="text-xs text-darc-velvet/60">vinculado a: {room.room.name}</p>
          )}
          {bounds.area && <p className="text-sm text-gray-500">{bounds.area} m² {bounds.sqft ? `(${bounds.sqft} sqft)` : ''}</p>}
          {bounds.dimensions && (
            <p className="text-xs text-gray-400">
              {bounds.dimensions.width} × {bounds.dimensions.depth} {bounds.dimensions.units || 'm'}
            </p>
          )}
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
      </div>

      {/* Vincular a um ambiente — destaque quando não vinculado */}
      {!isLinked && (
        <div className="px-4 py-3 bg-darc-sunfire/10 border-b border-darc-sunfire/30">
          <h4 className="font-semibold text-sm text-darc-velvet mb-1.5 flex items-center gap-1.5">
            🔗 Vincular a um ambiente
          </h4>
          <p className="text-xs text-darc-velvet/70 mb-2">
            Vincule esta marcação a um ambiente do projeto para ver despesas e subir fotos.
          </p>
          {projectRooms.length === 0 ? (
            <p className="text-xs italic text-darc-velvet/60">
              Nenhum ambiente cadastrado. Cadastre ambientes no projeto primeiro.
            </p>
          ) : (
            <select
              className="w-full text-sm border border-darc-linen rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:border-darc-red-bright"
              value=""
              onChange={(e) => {
                if (e.target.value) onLinkRoom(room.id, e.target.value);
              }}
            >
              <option value="">Escolha um ambiente...</option>
              {projectRooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          )}
        </div>
      )}

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
          {isLinked ? (
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="text-xs text-darc-red-bright hover:text-darc-raspberry flex items-center gap-1 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploading ? (
                <>
                  <RefreshCw className="w-3 h-3 animate-spin" /> Enviando...
                </>
              ) : (
                <>
                  <Plus className="w-3 h-3" /> Adicionar
                </>
              )}
            </button>
          ) : (
            <span className="text-[10px] italic text-darc-velvet/50">vincule um ambiente</span>
          )}
        </div>

        {uploadError && (
          <div className="mb-2 px-3 py-2 rounded-lg bg-darc-red-bright/10 border border-darc-red-bright/30 flex items-start gap-2 text-xs">
            <div className="flex-1 text-darc-raspberry">
              <p className="font-semibold mb-0.5">Falha no envio</p>
              <p className="text-darc-velvet/80">{uploadError}</p>
            </div>
            <button
              onClick={onDismissUploadError}
              className="p-0.5 text-darc-raspberry hover:bg-darc-red-bright/20 rounded"
              aria-label="Fechar"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

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
          <button
            type="button"
            disabled={!isLinked || uploading}
            onClick={() => fileRef.current?.click()}
            className="w-full mt-1 px-3 py-6 rounded-lg border-2 border-dashed border-darc-linen text-xs text-darc-velvet/60 hover:bg-darc-linen/30 disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-1"
          >
            {uploading ? (
              <>
                <RefreshCw className="w-5 h-5 animate-spin text-darc-red-bright" />
                <span>Enviando imagem...</span>
              </>
            ) : (
              <>
                <ImageIcon className="w-5 h-5 opacity-50" />
                <span>{isLinked ? 'Clique para enviar fotos do ambiente' : 'Sem imagens'}</span>
              </>
            )}
          </button>
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
                  className="absolute top-1 right-1 p-1 bg-darc-red-bright text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
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

// ─── Room Link Modal ─────────────────────────────────────────

function RoomLinkModal({
  projectRooms,
  alreadyLinkedIds,
  onConfirm,
  onCancel,
}: {
  projectRooms: Room[];
  alreadyLinkedIds: Set<string>;
  onConfirm: (input: { roomId?: string; label: string }) => void;
  onCancel: () => void;
}) {
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [customLabel, setCustomLabel] = useState('');
  const [mode, setMode] = useState<'existing' | 'custom'>(
    projectRooms.length > 0 ? 'existing' : 'custom',
  );

  const canConfirm =
    (mode === 'existing' && !!selectedRoomId) ||
    (mode === 'custom' && customLabel.trim().length > 0);

  const handleConfirm = () => {
    if (mode === 'existing' && selectedRoomId) {
      const r = projectRooms.find((x) => x.id === selectedRoomId);
      if (!r) return;
      onConfirm({ roomId: r.id, label: r.name });
    } else if (mode === 'custom' && customLabel.trim()) {
      onConfirm({ label: customLabel.trim() });
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-darc-velvet/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-darc-strong overflow-hidden">
        <div className="px-5 py-4 border-b border-darc-linen flex items-center justify-between">
          <div>
            <h3 className="font-bold text-darc-velvet text-base">Vincular ao ambiente</h3>
            <p className="text-xs text-darc-velvet/60 mt-0.5">
              Escolha um ambiente do projeto para criar o vínculo
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 hover:bg-darc-linen/40 rounded-lg text-darc-velvet/60"
            aria-label="Cancelar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {projectRooms.length > 0 && (
          <div className="flex gap-1 px-5 pt-4">
            <button
              onClick={() => setMode('existing')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                mode === 'existing'
                  ? 'bg-darc-red-bright text-white'
                  : 'bg-darc-linen/40 text-darc-velvet/70 hover:bg-darc-linen/70'
              }`}
            >
              Ambientes existentes
            </button>
            <button
              onClick={() => setMode('custom')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                mode === 'custom'
                  ? 'bg-darc-red-bright text-white'
                  : 'bg-darc-linen/40 text-darc-velvet/70 hover:bg-darc-linen/70'
              }`}
            >
              Nome livre
            </button>
          </div>
        )}

        <div className="p-5 max-h-[55vh] overflow-y-auto">
          {mode === 'existing' && projectRooms.length === 0 && (
            <p className="text-sm text-darc-velvet/60 italic">
              Nenhum ambiente cadastrado no projeto. Use &quot;Nome livre&quot;.
            </p>
          )}

          {mode === 'existing' && projectRooms.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {projectRooms.map((r) => {
                const isLinked = alreadyLinkedIds.has(r.id);
                const isSelected = selectedRoomId === r.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRoomId(r.id)}
                    className={`text-left px-3 py-2.5 rounded-lg border transition-all ${
                      isSelected
                        ? 'border-darc-red-bright bg-darc-red-bright/10 shadow-darc-soft'
                        : 'border-darc-linen bg-white hover:border-darc-blue-mist hover:bg-darc-linen/30'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-darc-velvet truncate">
                        {r.name}
                      </span>
                      {isLinked && (
                        <span
                          className="text-[9px] uppercase tracking-wider text-darc-sunfire bg-darc-sunfire/15 px-1.5 py-0.5 rounded-full"
                          title="Já vinculado a outra marcação"
                        >
                          em uso
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {mode === 'custom' && (
            <div>
              <label className="block text-xs font-semibold text-darc-velvet/70 mb-1.5 uppercase tracking-wider">
                Nome do cômodo
              </label>
              <input
                type="text"
                autoFocus
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customLabel.trim()) handleConfirm();
                }}
                placeholder="Ex.: Sala íntima"
                className="w-full px-3 py-2 rounded-lg border border-darc-linen focus:border-darc-red-bright focus:outline-none focus:ring-2 focus:ring-darc-blue-mist/40 text-sm text-darc-velvet"
              />
              <p className="text-[11px] text-darc-velvet/50 mt-1.5">
                A marcação ficará sem vínculo a um ambiente do projeto. Você poderá vincular
                depois pelo painel do cômodo.
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-darc-linen/30 border-t border-darc-linen flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium text-darc-velvet/70 hover:bg-darc-linen/60"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-darc-red-bright text-white hover:bg-darc-raspberry disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Vincular
          </button>
        </div>
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
  const [pendingBounds, setPendingBounds] = useState<Bounds | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [hoveredRoom, setHoveredRoom] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const imageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedRoom) return;
    const fresh = floorPlan.rooms.find((r) => r.id === selectedRoom.id);
    if (!fresh) {
      setSelectedRoom(null);
    } else if (fresh !== selectedRoom) {
      setSelectedRoom(fresh);
    }
  }, [floorPlan, selectedRoom]);

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

  const getPointerPercent = (e: React.PointerEvent) => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingMode) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* alguns navegadores não dão capture em mouse, ok */
    }
    setDrawStart(getPointerPercent(e));
    setDrawCurrent(null);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingMode || !drawStart) return;
    e.preventDefault();
    setDrawCurrent(getPointerPercent(e));
  };

  const handlePointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingMode || !drawStart || !drawCurrent) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* idem */
    }
    const bounds: Bounds = {
      x: Math.min(drawStart.x, drawCurrent.x),
      y: Math.min(drawStart.y, drawCurrent.y),
      width: Math.abs(drawCurrent.x - drawStart.x),
      height: Math.abs(drawCurrent.y - drawStart.y),
    };
    setDrawStart(null);
    setDrawCurrent(null);
    if (bounds.width < 2 || bounds.height < 2) return;
    setPendingBounds(bounds);
  };

  const confirmPendingRoom = async (input: { roomId?: string; label: string }) => {
    if (!pendingBounds) return;
    try {
      await api.post(`/projects/${PROJECT_ID}/floor-plans/${floorPlan.id}/rooms`, {
        label: input.label,
        bounds: JSON.stringify(pendingBounds),
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        ...(input.roomId ? { roomId: input.roomId } : {}),
      });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
    setPendingBounds(null);
    setDrawingMode(false);
  };

  const cancelPendingRoom = () => {
    setPendingBounds(null);
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
    setImageUploading(true);
    setImageUploadError(null);
    try {
      const compressed = await compressImage(file, { maxDimension: 1800, quality: 0.82 });
      const fd = new FormData();
      fd.append('file', compressed);
      await api.upload(`/projects/${PROJECT_ID}/floor-plans/room-images/${roomId}`, fd);
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao enviar imagem';
      setImageUploadError(msg);
      console.error('upload room image failed:', err);
    } finally {
      setImageUploading(false);
    }
  };

  const handleDeleteImage = async (imageId: string) => {
    try {
      await api.delete(`/projects/${PROJECT_ID}/floor-plans/room-images/image/${imageId}`);
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao remover imagem';
      setImageUploadError(msg);
      console.error('delete room image failed:', err);
    }
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
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  style={{
                    cursor: drawingMode ? 'crosshair' : 'grab',
                    touchAction: drawingMode ? 'none' : 'auto',
                  }}
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
                    const summary = summarizeRoom(room);
                    const showHoverCard = isHovered && !isSelected;
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

                        {/* Hover preview card */}
                        {showHoverCard && (
                          <div
                            className="absolute z-30 pointer-events-none rounded-xl bg-white border border-darc-linen shadow-darc-medium px-3 py-2.5 min-w-[180px]"
                            style={{
                              left: '50%',
                              transform: 'translateX(-50%)',
                              ...(b.y + b.height > 75
                                ? { bottom: 'calc(100% + 8px)' }
                                : { top: 'calc(100% + 8px)' }),
                            }}
                          >
                            <div
                              className="text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5"
                              style={{ color: room.color }}
                            >
                              {room.room?.name ?? room.label}
                            </div>
                            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                              <div className="rounded-md bg-darc-raspberry/10 px-1.5 py-1">
                                <p className="text-darc-velvet/60 uppercase tracking-wider text-[8px]">Pago</p>
                                <p className="font-bold text-darc-raspberry text-[11px]">{BRL(summary.pago)}</p>
                              </div>
                              <div className="rounded-md bg-darc-sunfire/15 px-1.5 py-1">
                                <p className="text-darc-velvet/60 uppercase tracking-wider text-[8px]">Previsto</p>
                                <p className="font-bold text-darc-sunfire text-[11px]">{BRL(summary.planejado)}</p>
                              </div>
                            </div>
                            <div className="mt-1.5 flex items-center justify-between text-[10px] text-darc-velvet/70">
                              <span>🛒 {summary.expenses.length} {summary.expenses.length === 1 ? 'item' : 'itens'}</span>
                              <span>📷 {summary.images.length}</span>
                            </div>
                            {!room.room && (
                              <p className="mt-1.5 text-[9px] italic text-darc-velvet/50">
                                Vincule um ambiente para ver detalhes
                              </p>
                            )}
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
            projectRooms={projectRooms}
            onClose={() => setSelectedRoom(null)}
            onUploadImage={handleUploadImage}
            onDeleteImage={handleDeleteImage}
            onLinkRoom={handleLinkRoom}
            uploading={imageUploading}
            uploadError={imageUploadError}
            onDismissUploadError={() => setImageUploadError(null)}
          />
        )}
      </div>

      {/* Modal: vincular ambiente após desenhar */}
      {pendingBounds && (
        <RoomLinkModal
          projectRooms={projectRooms}
          alreadyLinkedIds={
            new Set(
              floorPlan.rooms
                .map((r) => r.roomId)
                .filter((id): id is string => !!id),
            )
          }
          onConfirm={confirmPendingRoom}
          onCancel={cancelPendingRoom}
        />
      )}
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
  const [uploadError, setUploadError] = useState<string | null>(null);
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
    setUploadError(null);
    try {
      const compressed = await compressImage(file, { maxDimension: 2400, quality: 0.85 });
      const fd = new FormData();
      fd.append('file', compressed);
      fd.append('name', file.name.replace(/\.[^.]+$/, ''));
      const fp = await api.upload<FloorPlan>(`/projects/${PROJECT_ID}/floor-plans`, fd);
      // Wait a bit for Gemini analysis
      setTimeout(() => load(), 5000);
      setSelectedId(fp.id);
      load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha no upload';
      setUploadError(msg);
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🏗️ Plantas Baixas</h1>
          <p className="text-sm text-gray-500 mt-1">
            Faça upload das plantas do projeto. A IA identifica os cômodos automaticamente.
          </p>
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="self-start sm:self-auto px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 flex items-center gap-2 disabled:opacity-50"
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
      {uploadError && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-darc-red-bright/10 border border-darc-red-bright/30 text-sm text-darc-red flex items-start gap-2">
          <span className="font-semibold">Erro ao enviar:</span>
          <span className="flex-1">{uploadError}</span>
          <button
            type="button"
            onClick={() => setUploadError(null)}
            className="text-darc-red/70 hover:text-darc-red"
            aria-label="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

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
