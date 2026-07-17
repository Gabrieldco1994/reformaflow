import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GeminiService } from './gemini.service';
import * as fs from 'fs';
import * as path from 'path';

const UPLOADS_ROOT = (() => {
  const raw = process.env['UPLOADS_DIR'];
  if (!raw) return path.join(process.cwd(), 'uploads');
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
})();
const UPLOADS_DIR = path.join(UPLOADS_ROOT, 'floor-plans');

@Injectable()
export class FloorPlanService {
  private readonly logger = new Logger(FloorPlanService.name);

  constructor(
    private prisma: PrismaService,
    private gemini: GeminiService,
  ) {
    // Ensure uploads directory exists
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  async create(
    projectId: string,
    tenantId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string } | undefined,
    name?: string,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Arquivo não enviado (campo "file" obrigatório)');
    }
    if (!tenantId) {
      throw new BadRequestException('Tenant não identificado');
    }
    // Save file to disk
    const ext = path.extname(file.originalname) || '.png';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, file.buffer);

    const imageUrl = `/uploads/floor-plans/${filename}`;

    // Create floor plan record
    const floorPlan = await this.prisma.floorPlan.create({
      data: {
        projectId,
        tenantId,
        name: name || file.originalname.replace(/\.[^.]+$/, ''),
        imageUrl,
      },
    });

    // Analyze with Gemini Vision (async, don't block response)
    this.analyzeAndCreateRooms(floorPlan.id, file.buffer, file.mimetype).catch(
      (err) => this.logger.error(`Background analysis failed: ${err}`),
    );

    return floorPlan;
  }

  private async analyzeAndCreateRooms(
    floorPlanId: string,
    imageBuffer: Buffer,
    mimeType: string,
  ) {
    const base64 = imageBuffer.toString('base64');
    const result = await this.gemini.analyzeFloorPlan(base64, mimeType);

    if (!result.rooms || result.rooms.length === 0) {
      this.logger.warn(`No rooms detected for floor plan ${floorPlanId}`);
      return;
    }

    const colors = [
      '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6',
      '#EC4899', '#06B6D4', '#F97316', '#14B8A6', '#6366F1',
    ];

    for (let i = 0; i < result.rooms.length; i++) {
      const room = result.rooms[i];
      await this.prisma.floorPlanRoom.create({
        data: {
          floorPlanId,
          label: room.name,
          bounds: JSON.stringify({
            x: room.x,
            y: room.y,
            width: room.width,
            height: room.height,
            area: room.estimatedArea?.sqm,
            sqft: room.estimatedArea?.sqft,
            dimensions: room.dimensions,
            elements: room.elements,
          }),
          color: colors[i % colors.length],
        },
      });
    }

    this.logger.log(
      `Created ${result.rooms.length} room markers for floor plan ${floorPlanId}`,
    );
  }

  async findAll(projectId: string, tenantId: string) {
    return this.prisma.floorPlan.findMany({
      where: { projectId, tenantId, deletedAt: null },
      include: {
        rooms: {
          include: {
            room: {
              include: {
                expenses: { where: { deletedAt: null } },
                roomImages: { orderBy: { order: 'asc' } },
              },
            },
          },
        },
        markers: { include: { expense: true } },
      },
      orderBy: { order: 'asc' },
    });
  }

  async findOne(id: string, projectId: string, tenantId: string) {
    const fp = await this.prisma.floorPlan.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
      include: {
        rooms: {
          include: {
            room: {
              include: {
                expenses: { where: { deletedAt: null } },
                roomImages: { orderBy: { order: 'asc' } },
              },
            },
          },
        },
        markers: { include: { expense: true } },
      },
    });
    if (!fp) throw new NotFoundException('Floor plan not found');
    return fp;
  }

  async updateRoom(
    roomMarkerId: string,
    projectId: string,
    tenantId: string,
    data: { label?: string; bounds?: string; color?: string; roomId?: string | null },
  ) {
    await this.assertRoomMarkerTenant(roomMarkerId, projectId, tenantId);
    return this.prisma.floorPlanRoom.update({
      where: { id: roomMarkerId },
      data,
    });
  }

  async deleteRoom(roomMarkerId: string, projectId: string, tenantId: string) {
    await this.assertRoomMarkerTenant(roomMarkerId, projectId, tenantId);
    return this.prisma.floorPlanRoom.delete({
      where: { id: roomMarkerId },
    });
  }

  async createRoom(
    floorPlanId: string,
    projectId: string,
    tenantId: string,
    data: { label: string; bounds: string; color?: string; roomId?: string },
  ) {
    const floorPlan = await this.prisma.floorPlan.findFirst({
      where: { id: floorPlanId, projectId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!floorPlan) throw new NotFoundException('Floor plan not found');
    return this.prisma.floorPlanRoom.create({
      data: { floorPlanId, ...data },
    });
  }

  async delete(id: string, projectId: string, tenantId: string) {
    const fp = await this.prisma.floorPlan.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!fp) throw new NotFoundException('Floor plan not found');
    return this.prisma.floorPlan.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async update(
    id: string,
    projectId: string,
    tenantId: string,
    data: { name?: string; cropBounds?: string | null },
  ) {
    const fp = await this.prisma.floorPlan.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!fp) throw new NotFoundException('Floor plan not found');
    const patch: { name?: string; cropBounds?: string | null } = {};
    if (typeof data.name === 'string') patch.name = data.name;
    if ('cropBounds' in data) {
      const raw = data.cropBounds;
      if (raw === null || raw === undefined || raw === '') {
        patch.cropBounds = null;
      } else {
        let parsed: { x: number; y: number; width: number; height: number };
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new BadRequestException('cropBounds inválido (JSON malformado)');
        }
        const nums = [parsed.x, parsed.y, parsed.width, parsed.height];
        if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
          throw new BadRequestException('cropBounds inválido (x/y/width/height precisam ser números finitos)');
        }
        if (parsed.x < 0 || parsed.x > 100 || parsed.y < 0 || parsed.y > 100) {
          throw new BadRequestException('cropBounds fora dos limites (x/y devem estar entre 0 e 100)');
        }
        if (parsed.width <= 0 || parsed.width > 100 || parsed.height <= 0 || parsed.height > 100) {
          throw new BadRequestException('cropBounds fora dos limites (width/height devem estar entre 0 e 100, exclusivo)');
        }
        if (parsed.x + parsed.width > 100.01 || parsed.y + parsed.height > 100.01) {
          throw new BadRequestException('cropBounds excede 100% (x+width ou y+height)');
        }
        patch.cropBounds = JSON.stringify({
          x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height,
        });
      }
    }
    return this.prisma.floorPlan.update({ where: { id }, data: patch });
  }

  async reanalyze(id: string, projectId: string, tenantId: string) {
    const fp = await this.prisma.floorPlan.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!fp) throw new NotFoundException('Floor plan not found');

    // Delete existing auto-detected rooms (keep manually added ones with roomId)
    await this.prisma.floorPlanRoom.deleteMany({
      where: { floorPlanId: id, roomId: null },
    });

    // Read image from disk
    const filePath = path.join(process.cwd(), fp.imageUrl);
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(fp.imageUrl).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    const mimeType = mimeMap[ext] || 'image/png';

    await this.analyzeAndCreateRooms(id, buffer, mimeType);

    return this.findOne(id, projectId, tenantId);
  }

  // Room images
  async addRoomImage(
    projectId: string,
    roomId: string,
    tenantId: string,
    file: { buffer: Buffer; originalname: string; mimetype?: string; size?: number } | undefined,
    caption?: string,
  ) {
    this.logger.log(
      `addRoomImage(roomId=${roomId}, hasFile=${!!file}, size=${file?.size ?? 'n/a'}, mime=${file?.mimetype ?? 'n/a'}, name=${file?.originalname ?? 'n/a'})`,
    );
    if (!file?.buffer) {
      this.logger.warn(`addRoomImage: arquivo não enviado (roomId=${roomId})`);
      throw new BadRequestException('Arquivo não enviado (campo "file" obrigatório)');
    }
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, deletedAt: null, projectId, project: { tenantId } },
    });
    if (!room) {
      this.logger.warn(`addRoomImage: room não encontrado (roomId=${roomId})`);
      throw new NotFoundException(`Ambiente ${roomId} não encontrado`);
    }
    try {
      const dir = path.join(UPLOADS_ROOT, 'room-images');
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(file.originalname) || '.jpg';
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const filePath = path.join(dir, filename);
      fs.writeFileSync(filePath, file.buffer);
      this.logger.log(`addRoomImage: gravado em ${filePath} (${file.buffer.length} bytes)`);

      const created = await this.prisma.roomImage.create({
        data: {
          roomId,
          imageUrl: `/uploads/room-images/${filename}`,
          caption,
        },
      });
      this.logger.log(`addRoomImage: ok id=${created.id}`);
      return created;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`addRoomImage falhou: ${msg}`, err instanceof Error ? err.stack : undefined);
      throw err;
    }
  }

  async getRoomImages(projectId: string, roomId: string, tenantId: string) {
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, deletedAt: null, projectId, project: { tenantId } },
    });
    if (!room) throw new NotFoundException(`Ambiente ${roomId} não encontrado`);
    return this.prisma.roomImage.findMany({
      where: { roomId },
      orderBy: { order: 'asc' },
    });
  }

  async deleteRoomImage(projectId: string, id: string, tenantId: string) {
    const img = await this.prisma.roomImage.findFirst({
      where: { id },
      include: { room: { select: { projectId: true, project: { select: { tenantId: true } } } } },
    });
    if (
      !img ||
      img.room?.projectId !== projectId ||
      img.room?.project?.tenantId !== tenantId
    ) {
      throw new NotFoundException('Imagem não encontrada');
    }
    return this.prisma.roomImage.delete({ where: { id } });
  }

  // ─── Markers (Raio-X) ─────────────────────────────────────
  async createMarker(
    floorPlanId: string,
    projectId: string,
    tenantId: string,
    data: { expenseId: string; bounds: string },
  ) {
    await this.assertFloorPlanTenant(floorPlanId, projectId, tenantId);
    return this.prisma.floorPlanMarker.create({
      data: { floorPlanId, ...data },
      include: { expense: true },
    });
  }

  async deleteMarker(markerId: string, projectId: string, tenantId: string) {
    const marker = await this.prisma.floorPlanMarker.findFirst({
      where: { id: markerId },
      include: { floorPlan: { select: { projectId: true, tenantId: true, deletedAt: true } } },
    });
    if (
      !marker ||
      marker.floorPlan?.projectId !== projectId ||
      marker.floorPlan?.tenantId !== tenantId ||
      marker.floorPlan?.deletedAt
    ) {
      throw new NotFoundException('Marker não encontrado');
    }
    return this.prisma.floorPlanMarker.delete({ where: { id: markerId } });
  }

  private async assertFloorPlanTenant(
    floorPlanId: string,
    projectId: string,
    tenantId: string,
  ) {
    const fp = await this.prisma.floorPlan.findFirst({
      where: { id: floorPlanId, projectId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!fp) throw new NotFoundException('Floor plan not found');
  }

  private async assertRoomMarkerTenant(
    roomMarkerId: string,
    projectId: string,
    tenantId: string,
  ) {
    const marker = await this.prisma.floorPlanRoom.findFirst({
      where: { id: roomMarkerId },
      include: { floorPlan: { select: { projectId: true, tenantId: true, deletedAt: true } } },
    });
    if (
      !marker ||
      marker.floorPlan?.projectId !== projectId ||
      marker.floorPlan?.tenantId !== tenantId ||
      marker.floorPlan?.deletedAt
    ) {
      throw new NotFoundException('Room marker not found');
    }
  }
}
