'use client';
import { useProject } from '@/contexts/project-context';

import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { compressImage } from '@/lib/image-compress';
import { ExpenseTypeLabels } from '@reformaflow/domain';
import {
  Upload,
  Trash2,
  RefreshCw,
  Plus,
  X,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  Edit3,
  Image as ImageIcon,
  Map as MapIcon,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ScanLine,
  ShoppingBag,
  Search,
} from 'lucide-react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';

interface LinkPreview {
  url: string;
  ogImage: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  favicon: string | null;
}

function ShoppableThumb({
  link,
  imageUrl,
  title,
}: {
  link: string;
  imageUrl: string | null;
  title: string;
}) {
  const [imgError, setImgError] = useState(false);
  const { data: preview } = useQuery<LinkPreview>({
    queryKey: ['link-preview', link],
    queryFn: () => api.get(`/link-preview?url=${encodeURIComponent(link)}`),
    staleTime: 1000 * 60 * 60 * 24,
    retry: 1,
    enabled: !!link && !imageUrl,
  });

  const src = imageUrl || (!imgError ? preview?.ogImage : null);

  if (src) {
    return (
      <img
        src={src}
        alt={title}
        className="w-full h-full object-contain p-1"
        loading="lazy"
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div className="w-full h-full flex items-center justify-center text-darc-velvet/30">
      {preview?.favicon ? (
        <img
          src={preview.favicon}
          alt=""
          className="w-6 h-6 object-contain opacity-60"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <ImageIcon className="w-5 h-5" />
      )}
    </div>
  );
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const BRL = (centavos: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100);

function randomHexColor() {
  const h = Math.floor(Math.random() * 360);
  const s = 70;
  const l = 50;
  const c = (1 - Math.abs((2 * l) / 100 - 1)) * (s / 100);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l / 100 - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function parseColor(color: string): { r: number; g: number; b: number } | null {
  if (!color) return null;
  const hex = color.trim().replace('#', '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  const hslMatch = color.match(/^hsl\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*\)$/);
  if (hslMatch) {
    const h = Number(hslMatch[1]);
    const s = Number(hslMatch[2]) / 100;
    const l = Number(hslMatch[3]) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }
  return null;
}

function withAlpha(color: string, alpha: number): string {
  const parsed = parseColor(color);
  if (!parsed) return color;
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
}

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

interface FloorPlanMarkerExpense {
  id: string;
  titulo: string | null;
  valor: number;
  quantidade: number;
  valorTotal: number;
  status: string;
  tipoDespesa: string;
  link: string | null;
  imageUrl: string | null;
  fornecedor: string | null;
  roomId: string | null;
}

interface FloorPlanMarker {
  id: string;
  floorPlanId: string;
  expenseId: string;
  bounds: string;
  expense: FloorPlanMarkerExpense;
}

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
    expenses?: {
      id: string;
      titulo: string | null;
      valor: number;
      quantidade: number;
      valorTotal: number;
      status: string;
      tipoDespesa: string;
      link: string | null;
      imageUrl: string | null;
      fornecedor: string | null;
    }[];
    roomImages?: { id: string; imageUrl: string; caption?: string | null }[];
  };
}

interface FloorPlan {
  id: string;
  name: string;
  imageUrl: string;
  rooms: FloorPlanRoom[];
  markers?: FloorPlanMarker[];
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

// ─── Collapsible Section ────────────────────────────────────

function CollapsibleSection({
  title,
  icon,
  badge,
  defaultOpen = true,
  children,
  action,
}: {
  title: string;
  icon: string;
  badge?: string | null;
  defaultOpen?: boolean;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-darc-linen/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-darc-linen/30 transition-colors"
      >
        <span className="text-base leading-none" aria-hidden>{icon}</span>
        <span className="flex-1 text-left text-sm font-semibold text-darc-velvet">{title}</span>
        {badge != null && (
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-darc-linen/60 text-darc-velvet/70 font-semibold">
            {badge}
          </span>
        )}
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
        {open ? (
          <ChevronUp className="w-4 h-4 text-darc-velvet/60" />
        ) : (
          <ChevronDown className="w-4 h-4 text-darc-velvet/60" />
        )}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
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

  const groupedByType = useMemo(() => {
    const groups = new Map<string, typeof expenses>();
    for (const e of expenses) {
      const arr = groups.get(e.tipoDespesa) ?? [];
      arr.push(e);
      groups.set(e.tipoDespesa, arr);
    }
    return Array.from(groups.entries())
      .map(([tipo, items]) => ({
        tipo,
        items,
        total: items.reduce((s, i) => s + i.valorTotal, 0),
        pago: items.filter((i) => i.status === 'PAGO').reduce((s, i) => s + i.valorTotal, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [expenses]);

  const compraveis = useMemo(
    () => expenses.filter((e) => !!e.link),
    [expenses],
  );

  return (
    <>
      {/* Backdrop apenas mobile */}
      <div
        className="md:hidden fixed inset-0 z-40 bg-darc-velvet/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div
        className={[
          'fixed z-50 bg-white shadow-darc-strong overflow-hidden flex flex-col',
          // Mobile: bottom sheet
          'inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl',
          // Desktop: sidebar lateral
          'md:inset-y-0 md:right-0 md:left-auto md:bottom-auto md:top-0 md:h-full md:max-h-none md:w-[22rem] md:rounded-none md:border-l md:border-darc-linen',
        ].join(' ')}
        role="dialog"
        aria-label={`Detalhes de ${room.label}`}
      >
        {/* Handle drag (visual apenas, mobile) */}
        <div className="md:hidden flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 bg-darc-linen rounded-full" />
        </div>

        {/* Header sticky */}
        <div
          className="px-4 py-3 border-b border-darc-linen flex items-start justify-between gap-3"
          style={{ borderLeftColor: room.color, borderLeftWidth: 4 }}
        >
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-base text-darc-velvet truncate">{room.label}</h3>
            {room.room && room.room.name !== room.label && (
              <p className="text-[11px] text-darc-velvet/60 truncate">vinculado a: {room.room.name}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-darc-velvet/60">
              {bounds.area && (
                <span>
                  {bounds.area} m²{bounds.sqft ? ` (${bounds.sqft} sqft)` : ''}
                </span>
              )}
              {bounds.dimensions && (
                <span>
                  · {bounds.dimensions.width} × {bounds.dimensions.depth} {bounds.dimensions.units || 'm'}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-darc-linen/60 rounded-lg text-darc-velvet/70 flex-shrink-0"
            aria-label="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stats — sempre visíveis */}
        <div className="px-4 py-3 grid grid-cols-2 gap-2 border-b border-darc-linen bg-darc-linen/20">
          <div className="rounded-lg bg-darc-raspberry/10 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-darc-velvet/60 font-semibold">Pago</p>
            <p className="font-bold text-darc-raspberry text-sm">{BRL(totalPago)}</p>
          </div>
          <div className="rounded-lg bg-darc-sunfire/15 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-darc-velvet/60 font-semibold">Previsto</p>
            <p className="font-bold text-darc-sunfire text-sm">{BRL(totalPlanejado)}</p>
          </div>
        </div>

        {/* Vincular ambiente (se necessário) */}
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

        {/* Scroll área das seções */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {/* Imagens do Projeto */}
          <CollapsibleSection
            title="Imagens do Projeto"
            icon="📷"
            badge={images.length > 0 ? `${images.length}` : '0'}
            defaultOpen={images.length > 0}
            action={
              isLinked ? (
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="text-[11px] text-darc-red-bright hover:text-darc-raspberry flex items-center gap-1 font-semibold disabled:opacity-50 disabled:cursor-not-allowed px-2 py-0.5 rounded-md hover:bg-darc-red-bright/10"
                >
                  {uploading ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span className="hidden sm:inline">Enviando</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-3 h-3" />
                      <span>Adicionar</span>
                    </>
                  )}
                </button>
              ) : null
            }
          >
            {uploadError && (
              <div className="mb-2 px-3 py-2 rounded-lg bg-darc-red-bright/10 border border-darc-red-bright/30 flex items-start gap-2 text-xs">
                <div className="flex-1 text-darc-raspberry">
                  <p className="font-semibold mb-0.5">Falha no envio</p>
                  <p className="text-darc-velvet/80 break-words">{uploadError}</p>
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
                className="w-full px-3 py-6 rounded-lg border-2 border-dashed border-darc-linen text-xs text-darc-velvet/60 hover:bg-darc-linen/30 disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-1"
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
              <div className="grid grid-cols-3 sm:grid-cols-2 gap-2">
                {images.map((img) => (
                  <div key={img.id} className="relative group aspect-square">
                    <img
                      src={`${API_BASE}${img.imageUrl}`}
                      alt={img.caption || ''}
                      className="w-full h-full object-cover rounded-lg"
                      loading="lazy"
                    />
                    <button
                      onClick={() => onDeleteImage(img.id)}
                      className="absolute top-1 right-1 p-1 bg-darc-red-bright text-white rounded-full opacity-0 group-hover:opacity-100 active:opacity-100 transition-opacity shadow"
                      aria-label="Remover imagem"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* Despesas — agrupadas por tipo */}
          <CollapsibleSection
            title="Despesas"
            icon="💰"
            badge={expenses.length > 0 ? `${expenses.length}` : '0'}
            defaultOpen={true}
          >
            {expenses.length === 0 ? (
              <p className="text-sm italic text-darc-velvet/50">Nenhuma despesa vinculada</p>
            ) : (
              <div className="space-y-1.5">
                {groupedByType.map((group) => (
                  <ExpenseTypeGroup key={group.tipo} group={group} />
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* Compráveis — despesas com link */}
          <CollapsibleSection
            title="Compráveis"
            icon="🛒"
            badge={compraveis.length > 0 ? `${compraveis.length}` : '0'}
            defaultOpen={compraveis.length > 0}
          >
            {compraveis.length === 0 ? (
              <p className="text-sm italic text-darc-velvet/50">
                Nenhum item com link cadastrado neste ambiente.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {compraveis.map((e) => (
                  <a
                    key={e.id}
                    href={e.link!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group rounded-lg border border-darc-linen overflow-hidden bg-white hover:border-darc-red-bright hover:shadow-darc-soft transition-all"
                  >
                    <div className="aspect-square bg-darc-linen/40 relative">
                      <ShoppableThumb
                        link={e.link!}
                        imageUrl={e.imageUrl}
                        title={e.titulo || e.fornecedor || ''}
                      />
                      <span
                        className={`absolute top-0.5 right-0.5 text-[8px] uppercase tracking-wider px-1 py-0.5 rounded-full font-bold ${
                          e.status === 'PAGO'
                            ? 'bg-darc-raspberry text-white'
                            : 'bg-darc-sunfire text-darc-velvet'
                        }`}
                      >
                        {e.status === 'PAGO' ? 'pago' : 'previsto'}
                      </span>
                    </div>
                    <div className="px-1.5 py-1">
                      <p className="text-[10px] font-semibold text-darc-velvet truncate leading-tight">
                        {e.titulo || e.fornecedor || ExpenseTypeLabels[e.tipoDespesa as keyof typeof ExpenseTypeLabels] || e.tipoDespesa}
                      </p>
                      <div className="flex items-center justify-between gap-1 mt-0.5">
                        <span className="text-[10px] font-bold text-darc-red-bright truncate">
                          {BRL(e.valorTotal)}
                        </span>
                        <ExternalLink className="w-2.5 h-2.5 text-darc-velvet/40 group-hover:text-darc-red-bright shrink-0" />
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </CollapsibleSection>

          {/* Elementos detectados (se houver) */}
          {bounds.elements && bounds.elements.length > 0 && (
            <CollapsibleSection
              title="Elementos detectados"
              icon="🏠"
              badge={`${bounds.elements.length}`}
              defaultOpen={false}
            >
              <div className="flex flex-wrap gap-1">
                {bounds.elements.map((el, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 bg-darc-linen/50 text-darc-velvet/70 text-[11px] rounded-full"
                  >
                    {el}
                  </span>
                ))}
              </div>
            </CollapsibleSection>
          )}
        </div>
      </div>
    </>
  );
}

function ExpenseTypeGroup({
  group,
}: {
  group: {
    tipo: string;
    items: NonNullable<NonNullable<FloorPlanRoom['room']>['expenses']>;
    total: number;
    pago: number;
  };
}) {
  const [open, setOpen] = useState(false);
  const label =
    ExpenseTypeLabels[group.tipo as keyof typeof ExpenseTypeLabels] ?? group.tipo;
  const pct = group.total > 0 ? Math.round((group.pago / group.total) * 100) : 0;
  return (
    <div className="rounded-lg border border-darc-linen overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-darc-linen/30 transition-colors"
      >
        <div className="flex-1 min-w-0 text-left">
          <p className="text-xs font-semibold text-darc-velvet truncate">{label}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-darc-velvet/60">
              {group.items.length} {group.items.length === 1 ? 'item' : 'itens'}
            </span>
            {pct > 0 && (
              <span className="text-[10px] text-darc-raspberry font-semibold">
                {pct}% pago
              </span>
            )}
          </div>
        </div>
        <span className="text-xs font-bold text-darc-velvet whitespace-nowrap">
          {BRL(group.total)}
        </span>
        {open ? (
          <ChevronUp className="w-3.5 h-3.5 text-darc-velvet/60" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-darc-velvet/60" />
        )}
      </button>
      {open && (
        <div className="border-t border-darc-linen bg-darc-linen/20 px-2 py-1.5 space-y-1">
          {group.items.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-2 text-[11px] px-1.5 py-1 rounded bg-white"
            >
              <span className="flex-1 truncate text-darc-velvet">
                {e.titulo || e.fornecedor || '—'}
              </span>
              {e.quantidade > 1 && (
                <span className="text-darc-velvet/50">×{e.quantidade}</span>
              )}
              <span
                className={`font-semibold whitespace-nowrap ${
                  e.status === 'PAGO' ? 'text-darc-raspberry' : 'text-darc-sunfire'
                }`}
              >
                {BRL(e.valorTotal)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Marker Link Modal (Raio-X) ──────────────────────────────

function MarkerLinkModal({
  expenses,
  alreadyMarkedIds,
  onConfirm,
  onCancel,
}: {
  expenses: FloorPlanMarkerExpense[];
  alreadyMarkedIds: Set<string>;
  onConfirm: (expenseId: string) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expenses
      .filter((e) => {
        if (!q) return true;
        const hay = `${e.titulo ?? ''} ${e.fornecedor ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (a.titulo ?? '').localeCompare(b.titulo ?? ''));
  }, [expenses, search]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-darc-velvet/80 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-darc-strong overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-darc-linen flex items-center justify-between">
          <div>
            <h3 className="font-bold text-darc-velvet text-base flex items-center gap-2">
              <ScanLine className="w-4 h-4 text-darc-sunfire" /> Associar comprável
            </h3>
            <p className="text-xs text-darc-velvet/60 mt-0.5">
              Escolha o item que você marcou na planta
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

        <div className="px-5 pt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-darc-velvet/40" />
            <input
              type="text"
              placeholder="Buscar por nome ou fornecedor..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-darc-linen bg-darc-linen/20 text-sm focus:outline-none focus:border-darc-sunfire"
            />
          </div>
        </div>

        <div className="p-5 flex-1 overflow-y-auto min-h-0">
          {filtered.length === 0 && (
            <p className="text-sm text-darc-velvet/60 italic text-center py-8">
              {expenses.length === 0
                ? 'Nenhum comprável cadastrado neste projeto. Adicione despesas com link em Despesas.'
                : 'Nenhum resultado para essa busca.'}
            </p>
          )}
          {filtered.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {filtered.map((e) => {
                const isMarked = alreadyMarkedIds.has(e.id);
                const isSelected = selectedId === e.id;
                return (
                  <button
                    key={e.id}
                    onClick={() => setSelectedId(e.id)}
                    className={`group text-left rounded-xl border overflow-hidden transition-all ${
                      isSelected
                        ? 'border-darc-sunfire bg-darc-sunfire/10 ring-2 ring-darc-sunfire'
                        : isMarked
                        ? 'border-darc-linen bg-darc-linen/30 opacity-60'
                        : 'border-darc-linen bg-white hover:border-darc-sunfire/50'
                    }`}
                  >
                    <div className="h-20 bg-darc-linen/20 flex items-center justify-center overflow-hidden">
                      {e.link ? (
                        <ShoppableThumb link={e.link} imageUrl={e.imageUrl} title={e.titulo ?? ''} />
                      ) : (
                        <ShoppingBag className="w-6 h-6 text-darc-velvet/30" />
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="text-[11px] font-semibold text-darc-velvet line-clamp-2 leading-tight">
                        {e.titulo ?? 'Sem título'}
                      </p>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[10px] text-darc-velvet/60">{e.fornecedor ?? ''}</span>
                        <span className="text-[10px] font-bold text-darc-sunfire">{BRL(e.valorTotal)}</span>
                      </div>
                      {isMarked && (
                        <span className="text-[9px] uppercase tracking-wider text-darc-velvet/50 italic">
                          já marcado
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-darc-linen flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-darc-velvet/70 hover:bg-darc-linen/40"
          >
            Cancelar
          </button>
          <button
            onClick={() => selectedId && onConfirm(selectedId)}
            disabled={!selectedId}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-darc-sunfire text-white hover:bg-darc-sunfire/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Associar
          </button>
        </div>
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

  // ─── Raio-X (markers) state ───────────────────────────────
  const [xrayMode, setXrayMode] = useState(false);
  const [markerDrawingMode, setMarkerDrawingMode] = useState(false);
  const [pendingMarkerBounds, setPendingMarkerBounds] = useState<Bounds | null>(null);
  const [hoveredMarker, setHoveredMarker] = useState<string | null>(null);

  const { data: shoppableExpenses = [] } = useQuery<FloorPlanMarkerExpense[]>({
    queryKey: ['expenses-shoppable', PROJECT_ID],
    queryFn: async () => {
      const all = await api.get<FloorPlanMarkerExpense[]>(`/projects/${PROJECT_ID}/expenses`);
      return (all || []).filter((e) => !!e.link);
    },
    enabled: xrayMode,
    staleTime: 1000 * 60,
  });

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
    if (!drawingMode && !markerDrawingMode) return;
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
    if ((!drawingMode && !markerDrawingMode) || !drawStart) return;
    e.preventDefault();
    setDrawCurrent(getPointerPercent(e));
  };

  const handlePointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    if ((!drawingMode && !markerDrawingMode) || !drawStart || !drawCurrent) return;
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
    const wasMarker = markerDrawingMode;
    setDrawStart(null);
    setDrawCurrent(null);
    if (bounds.width < 1 || bounds.height < 1) return;
    if (wasMarker) {
      setPendingMarkerBounds(bounds);
    } else {
      setPendingBounds(bounds);
    }
  };

  const confirmPendingRoom = async (input: { roomId?: string; label: string }) => {
    if (!pendingBounds) return;
    try {
      await api.post(`/projects/${PROJECT_ID}/floor-plans/${floorPlan.id}/rooms`, {
        label: input.label,
        bounds: JSON.stringify(pendingBounds),
        color: randomHexColor(),
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

  // ─── Markers (Raio-X) handlers ────────────────────────────
  const confirmPendingMarker = async (expenseId: string) => {
    if (!pendingMarkerBounds) return;
    try {
      await api.post(`/projects/${PROJECT_ID}/floor-plans/${floorPlan.id}/markers`, {
        expenseId,
        bounds: JSON.stringify(pendingMarkerBounds),
      });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
    setPendingMarkerBounds(null);
    setMarkerDrawingMode(false);
  };

  const cancelPendingMarker = () => {
    setPendingMarkerBounds(null);
    setMarkerDrawingMode(false);
  };

  const handleDeleteMarker = async (markerId: string) => {
    if (!confirm('Remover esta marcação?')) return;
    try {
      await api.delete(`/projects/${PROJECT_ID}/floor-plans/markers/${markerId}`);
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  const exitXrayMode = () => {
    setXrayMode(false);
    setMarkerDrawingMode(false);
    setPendingMarkerBounds(null);
    setHoveredMarker(null);
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
          onClick={() => setXrayMode(true)}
          className="px-3 py-1.5 rounded-lg text-sm flex items-center gap-1 bg-darc-sunfire/15 text-darc-sunfire hover:bg-darc-sunfire/25 font-semibold"
          title="Marcar objetos compráveis na planta"
        >
          <ScanLine className="w-4 h-4" /> Raio-X
          {(floorPlan.markers?.length ?? 0) > 0 && (
            <span className="ml-1 text-[10px] bg-darc-sunfire text-white rounded-full px-1.5 py-0.5 leading-none">
              {floorPlan.markers!.length}
            </span>
          )}
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
          disabled={drawingMode || markerDrawingMode}
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
                    cursor: drawingMode || markerDrawingMode ? 'crosshair' : 'grab',
                    touchAction: drawingMode || markerDrawingMode ? 'none' : 'auto',
                  }}
                >
                  <img
                    src={`${API_BASE}${floorPlan.imageUrl}`}
                    alt={floorPlan.name}
                    width={1600}
                    height={1200}
                    className="max-w-full max-h-[75vh] w-auto h-auto select-none"
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
                          backgroundColor: withAlpha(room.color, isHovered || isSelected ? 0.25 : 0.12),
                          borderWidth: 2,
                          borderStyle: 'dashed',
                          borderColor: withAlpha(room.color, isHovered || isSelected ? 1 : 0.8),
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
                            {summary.images.length > 0 && (
                              <div className="-mx-3 -mt-2.5 mb-2 h-24 overflow-hidden bg-darc-linen/30 rounded-t-xl">
                                <img
                                  src={`${API_BASE}${summary.images[0].imageUrl}`}
                                  alt={room.room?.name ?? room.label}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                              </div>
                            )}
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

                  {/* Marker overlays (Raio-X) */}
                  {(floorPlan.markers ?? []).map((marker) => {
                    let mb: Bounds;
                    try {
                      mb = JSON.parse(marker.bounds);
                    } catch {
                      return null;
                    }
                    const isHovered = hoveredMarker === marker.id;
                    const e = marker.expense;
                    return (
                      <div
                        key={marker.id}
                        onMouseEnter={() => setHoveredMarker(marker.id)}
                        onMouseLeave={() => setHoveredMarker(null)}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (e?.link) {
                            window.open(e.link, '_blank', 'noopener,noreferrer');
                          }
                        }}
                        className="absolute transition-all duration-150 group"
                        style={{
                          left: `${mb.x}%`,
                          top: `${mb.y}%`,
                          width: `${mb.width}%`,
                          height: `${mb.height}%`,
                          backgroundColor: isHovered ? 'rgba(255, 145, 0, 0.30)' : 'rgba(255, 145, 0, 0.15)',
                          borderWidth: 2,
                          borderStyle: 'dashed',
                          borderColor: isHovered ? '#FF9100' : 'rgba(255, 145, 0, 0.75)',
                          borderRadius: 4,
                          cursor: e?.link ? 'pointer' : 'default',
                          zIndex: isHovered ? 25 : 15,
                        }}
                      >
                        {/* Botão fechar pequeno */}
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            handleDeleteMarker(marker.id);
                          }}
                          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-darc-velvet/80 hover:bg-darc-velvet text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-30"
                          aria-label="Remover marca"
                        >
                          <X className="w-3 h-3" />
                        </button>

                        {/* Hover card mostrando comprável */}
                        {isHovered && (
                          <div
                            className="absolute z-40 pointer-events-none rounded-xl bg-white border border-darc-linen shadow-darc-medium overflow-hidden w-[200px]"
                            style={{
                              left: '50%',
                              transform: 'translateX(-50%)',
                              ...(mb.y + mb.height > 75
                                ? { bottom: 'calc(100% + 8px)' }
                                : { top: 'calc(100% + 8px)' }),
                            }}
                          >
                            <div className="h-24 bg-darc-linen/20 flex items-center justify-center overflow-hidden">
                              {e?.link ? (
                                <ShoppableThumb
                                  link={e.link}
                                  imageUrl={e.imageUrl}
                                  title={e.titulo ?? ''}
                                />
                              ) : (
                                <ShoppingBag className="w-6 h-6 text-darc-velvet/30" />
                              )}
                            </div>
                            <div className="px-3 py-2">
                              <p className="text-[11px] font-bold text-darc-velvet line-clamp-2 leading-tight">
                                {e?.titulo ?? 'Sem título'}
                              </p>
                              {e?.fornecedor && (
                                <p className="text-[9px] text-darc-velvet/60 mt-0.5 truncate">
                                  {e.fornecedor}
                                </p>
                              )}
                              <div className="flex items-center justify-between mt-1.5">
                                <span className="text-[10px] font-bold text-darc-sunfire">
                                  {BRL(e?.valorTotal ?? 0)}
                                </span>
                                {e?.link && (
                                  <ExternalLink className="w-3 h-3 text-darc-velvet/40" />
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Drawing preview */}
                  {drawStart && drawCurrent && (
                    <div
                      className={`absolute border-2 border-dashed pointer-events-none ${
                        markerDrawingMode
                          ? 'border-darc-sunfire bg-darc-sunfire/30'
                          : 'border-blue-500 bg-blue-200/30'
                      }`}
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

      {/* ─── Raio-X Full-Screen Overlay ─── */}
      {xrayMode && (
        <XRayOverlay
          floorPlan={floorPlan}
          drawingMode={markerDrawingMode}
          drawStart={drawStart}
          drawCurrent={drawCurrent}
          hoveredMarker={hoveredMarker}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onToggleDrawing={() => setMarkerDrawingMode((v) => !v)}
          onSetHoveredMarker={setHoveredMarker}
          onDeleteMarker={handleDeleteMarker}
          onExit={exitXrayMode}
          imageRef={imageRef}
        />
      )}

      {/* Modal: associar comprável ao marker desenhado */}
      {pendingMarkerBounds && (
        <MarkerLinkModal
          expenses={shoppableExpenses}
          alreadyMarkedIds={
            new Set((floorPlan.markers ?? []).map((m) => m.expenseId))
          }
          onConfirm={confirmPendingMarker}
          onCancel={cancelPendingMarker}
        />
      )}
    </div>
  );
}

// ─── X-Ray Overlay (Modo Raio-X) ────────────────────────────

function XRayOverlay({
  floorPlan,
  drawingMode,
  drawStart,
  drawCurrent,
  hoveredMarker,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onToggleDrawing,
  onSetHoveredMarker,
  onDeleteMarker,
  onExit,
  imageRef,
}: {
  floorPlan: FloorPlan;
  drawingMode: boolean;
  drawStart: { x: number; y: number } | null;
  drawCurrent: { x: number; y: number } | null;
  hoveredMarker: string | null;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void | Promise<void>;
  onToggleDrawing: () => void;
  onSetHoveredMarker: (id: string | null) => void;
  onDeleteMarker: (id: string) => void;
  onExit: () => void;
  imageRef: React.RefObject<HTMLDivElement>;
}) {
  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onExit]);

  return (
    <div className="fixed inset-0 z-[70] bg-darc-velvet flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-darc-velvet text-white border-b border-white/10">
        <ScanLine className="w-5 h-5 text-darc-sunfire" />
        <h2 className="font-bold text-base flex-1 truncate">
          Raio-X — <span className="text-darc-sunfire">{floorPlan.name}</span>
        </h2>
        <button
          onClick={onToggleDrawing}
          className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1 font-semibold transition-colors ${
            drawingMode
              ? 'bg-darc-sunfire text-darc-velvet'
              : 'bg-white/10 text-white hover:bg-white/20'
          }`}
        >
          <Edit3 className="w-4 h-4" />
          {drawingMode ? 'Desenhando item...' : 'Marcar item'}
        </button>
        <span className="text-xs text-white/60 hidden sm:inline">
          {floorPlan.markers?.length ?? 0} {(floorPlan.markers?.length ?? 0) === 1 ? 'item' : 'itens'}
        </span>
        <button
          onClick={onExit}
          className="p-1.5 rounded-lg hover:bg-white/10"
          aria-label="Sair do Raio-X"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        <TransformWrapper
          disabled={drawingMode}
          minScale={0.3}
          maxScale={8}
          centerOnInit
          initialScale={2}
        >
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <div className="absolute top-3 left-3 z-30 flex flex-col gap-1">
                <button onClick={() => zoomIn()} className="p-2 bg-white/90 rounded-lg shadow hover:bg-white">
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button onClick={() => zoomOut()} className="p-2 bg-white/90 rounded-lg shadow hover:bg-white">
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button onClick={() => resetTransform()} className="p-2 bg-white/90 rounded-lg shadow hover:bg-white">
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>

              <TransformComponent
                wrapperClass="!w-full !h-full"
                contentClass="!w-full !h-full flex items-center justify-center"
              >
                <div
                  ref={imageRef}
                  className="relative inline-block"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  style={{
                    cursor: drawingMode ? 'crosshair' : 'grab',
                    touchAction: drawingMode ? 'none' : 'auto',
                  }}
                >
                  <img
                    src={`${API_BASE}${floorPlan.imageUrl}`}
                    alt={floorPlan.name}
                    width={1600}
                    height={1200}
                    className="max-w-[95vw] max-h-[calc(100vh-7rem)] w-auto h-auto select-none"
                    draggable={false}
                  />

                  {/* Markers */}
                  {(floorPlan.markers ?? []).map((marker) => {
                    let mb: Bounds;
                    try {
                      mb = JSON.parse(marker.bounds);
                    } catch {
                      return null;
                    }
                    const isHovered = hoveredMarker === marker.id;
                    const e = marker.expense;
                    return (
                      <div
                        key={marker.id}
                        onMouseEnter={() => onSetHoveredMarker(marker.id)}
                        onMouseLeave={() => onSetHoveredMarker(null)}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (e?.link) {
                            window.open(e.link, '_blank', 'noopener,noreferrer');
                          }
                        }}
                        className="absolute transition-all duration-150 group"
                        style={{
                          left: `${mb.x}%`,
                          top: `${mb.y}%`,
                          width: `${mb.width}%`,
                          height: `${mb.height}%`,
                          backgroundColor: isHovered ? 'rgba(255, 145, 0, 0.35)' : 'rgba(255, 145, 0, 0.18)',
                          borderWidth: 2,
                          borderStyle: 'dashed',
                          borderColor: isHovered ? '#FF9100' : 'rgba(255, 145, 0, 0.85)',
                          borderRadius: 4,
                          cursor: e?.link ? 'pointer' : 'default',
                          zIndex: isHovered ? 25 : 15,
                        }}
                      >
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onDeleteMarker(marker.id);
                          }}
                          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-white/95 hover:bg-white text-darc-velvet flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-30 shadow"
                          aria-label="Remover marca"
                        >
                          <X className="w-3 h-3" />
                        </button>

                        {isHovered && (
                          <div
                            className="absolute z-40 pointer-events-none rounded-lg bg-white border border-darc-linen shadow-darc-medium overflow-hidden w-[150px]"
                            style={{
                              left: '50%',
                              transform: 'translateX(-50%)',
                              ...(mb.y + mb.height > 75
                                ? { bottom: 'calc(100% + 6px)' }
                                : { top: 'calc(100% + 6px)' }),
                            }}
                          >
                            <div className="h-16 bg-darc-linen/20 flex items-center justify-center overflow-hidden">
                              {e?.link ? (
                                <ShoppableThumb
                                  link={e.link}
                                  imageUrl={e.imageUrl}
                                  title={e.titulo ?? ''}
                                />
                              ) : (
                                <ShoppingBag className="w-5 h-5 text-darc-velvet/30" />
                              )}
                            </div>
                            <div className="px-2 py-1.5">
                              <p className="text-[10px] font-bold text-darc-velvet line-clamp-2 leading-tight">
                                {e?.titulo ?? 'Sem título'}
                              </p>
                              {e?.fornecedor && (
                                <p className="text-[9px] text-darc-velvet/60 mt-0.5 truncate">
                                  {e.fornecedor}
                                </p>
                              )}
                              <div className="flex items-center justify-between mt-1">
                                <span className="text-[10px] font-bold text-darc-sunfire">
                                  {BRL(e?.valorTotal ?? 0)}
                                </span>
                                {e?.link && (
                                  <ExternalLink className="w-2.5 h-2.5 text-darc-velvet/40" />
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Drawing preview */}
                  {drawStart && drawCurrent && drawingMode && (
                    <div
                      className="absolute border-2 border-dashed border-darc-sunfire bg-darc-sunfire/25 pointer-events-none"
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

        {/* Help banner */}
        {(floorPlan.markers?.length ?? 0) === 0 && !drawingMode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur rounded-xl px-4 py-2.5 shadow-darc-medium text-center text-sm text-darc-velvet max-w-md">
            <p className="font-semibold mb-0.5">🔬 Marque objetos compráveis</p>
            <p className="text-xs text-darc-velvet/70">
              Clique em <span className="font-semibold text-darc-sunfire">&quot;Marcar item&quot;</span>,
              desenhe um retângulo sobre o objeto e associe a um item da sua lista de compráveis.
            </p>
          </div>
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
      <div className="animate-pulse">
        {/* Header skeleton (mesmas dimensões) */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div className="flex-1">
            <div className="h-8 w-56 bg-gray-200 rounded mb-2" />
            <div className="h-4 w-72 bg-gray-100 rounded" />
          </div>
          <div className="h-10 w-32 bg-gray-200 rounded-xl" />
        </div>
        {/* Grid skeleton (3 cards de 192px) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-white overflow-hidden">
              <div className="h-48 bg-gray-100" />
              <div className="p-3">
                <div className="h-4 w-32 bg-gray-100 rounded" />
                <div className="h-3 w-24 bg-gray-50 rounded mt-2" />
              </div>
            </div>
          ))}
        </div>
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
