import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
    file: { buffer: Buffer; mimetype: string; originalname: string },
    name?: string,
  ) {
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
            room: { include: { expenses: { where: { deletedAt: null } } } },
          },
        },
      },
      orderBy: { order: 'asc' },
    });
  }

  async findOne(id: string, tenantId: string) {
    const fp = await this.prisma.floorPlan.findFirst({
      where: { id, tenantId, deletedAt: null },
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
      },
    });
    if (!fp) throw new NotFoundException('Floor plan not found');
    return fp;
  }

  async updateRoom(
    roomMarkerId: string,
    data: { label?: string; bounds?: string; color?: string; roomId?: string | null },
  ) {
    return this.prisma.floorPlanRoom.update({
      where: { id: roomMarkerId },
      data,
    });
  }

  async deleteRoom(roomMarkerId: string) {
    return this.prisma.floorPlanRoom.delete({
      where: { id: roomMarkerId },
    });
  }

  async createRoom(
    floorPlanId: string,
    data: { label: string; bounds: string; color?: string; roomId?: string },
  ) {
    return this.prisma.floorPlanRoom.create({
      data: { floorPlanId, ...data },
    });
  }

  async delete(id: string, tenantId: string) {
    const fp = await this.prisma.floorPlan.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!fp) throw new NotFoundException('Floor plan not found');
    return this.prisma.floorPlan.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async reanalyze(id: string, tenantId: string) {
    const fp = await this.prisma.floorPlan.findFirst({
      where: { id, tenantId, deletedAt: null },
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

    return this.findOne(id, tenantId);
  }

  // Room images
  async addRoomImage(
    roomId: string,
    file: { buffer: Buffer; originalname: string },
    caption?: string,
  ) {
    const dir = path.join(UPLOADS_ROOT, 'room-images');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(file.originalname) || '.png';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    fs.writeFileSync(path.join(dir, filename), file.buffer);

    return this.prisma.roomImage.create({
      data: {
        roomId,
        imageUrl: `/uploads/room-images/${filename}`,
        caption,
      },
    });
  }

  async getRoomImages(roomId: string) {
    return this.prisma.roomImage.findMany({
      where: { roomId },
      orderBy: { order: 'asc' },
    });
  }

  async deleteRoomImage(id: string) {
    return this.prisma.roomImage.delete({ where: { id } });
  }
}
