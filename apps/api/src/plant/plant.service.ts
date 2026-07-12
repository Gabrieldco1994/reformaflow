import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlantDto, UpdatePlantDto } from './dto/plant.dto';
import * as fs from 'fs';
import * as path from 'path';

const UPLOADS_ROOT = (() => {
  const raw = process.env['UPLOADS_DIR'];
  if (!raw) return path.join(process.cwd(), 'uploads');
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
})();
const PLANTS_UPLOADS_DIR = path.join(UPLOADS_ROOT, 'plants');

/**
 * Raster MIME types accepted for plant photos.
 *
 * SVG is intentionally excluded: it is a valid `image/*` type but can embed
 * JavaScript and cause stored XSS when served back by the CDN/static server.
 * GIF is excluded because the frontend compressor never produces it.
 * Extension is canonical and derived from this map — never from originalname.
 */
const PLANT_PHOTO_ALLOWED_MIMES: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

@Injectable()
export class PlantService {
  constructor(private readonly prisma: PrismaService) {
    fs.mkdirSync(PLANTS_UPLOADS_DIR, { recursive: true });
  }

  async findAll(tenantId: string, projectId: string) {
    return this.prisma.plant.findMany({
      where: { tenantId, projectId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findById(tenantId: string, projectId: string, id: string) {
    const plant = await this.prisma.plant.findFirst({
      where: { id, tenantId, projectId },
    });
    if (!plant) throw new NotFoundException('Planta não encontrada');
    return plant;
  }

  async create(tenantId: string, projectId: string, dto: CreatePlantDto) {
    return this.prisma.plant.create({
      data: {
        tenantId,
        projectId,
        nome: dto.nome,
        localizacao: dto.localizacao,
        observacoes: dto.observacoes,
      },
    });
  }

  async update(tenantId: string, projectId: string, id: string, dto: UpdatePlantDto) {
    await this.findById(tenantId, projectId, id);
    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome;
    if (dto.localizacao !== undefined) data.localizacao = dto.localizacao;
    if (dto.observacoes !== undefined) data.observacoes = dto.observacoes;
    // Marcação manual de saúde (ex: "curei ela") — sem precisar nova foto/IA.
    if (dto.ultimaSaude !== undefined) data.ultimaSaude = dto.ultimaSaude;
    return this.prisma.plant.update({ where: { id }, data });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.findById(tenantId, projectId, id);
    await this.prisma.plant.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Salva uma foto (buffer) como referência visual da planta, sobrescrevendo
   * a anterior. Usado tanto pelo upload manual (endpoint) quanto pelo fluxo
   * de diagnóstico automático (a foto enviada vira o "retrato" da planta).
   *
   * Security: only raster MIME types in PLANT_PHOTO_ALLOWED_MIMES are accepted.
   * SVG is explicitly blocked (stored-XSS vector). The stored filename extension
   * is derived from the allow-listed MIME, never from the attacker-controlled
   * `originalname`.
   */
  async setPhoto(
    tenantId: string,
    projectId: string,
    id: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
  ) {
    await this.findById(tenantId, projectId, id);

    const ext = PLANT_PHOTO_ALLOWED_MIMES[file.mimetype];
    if (!ext) {
      throw new BadRequestException(
        'Formato de imagem não suportado. Envie JPEG, PNG, WebP, HEIC ou HEIF.',
      );
    }

    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    fs.writeFileSync(path.join(PLANTS_UPLOADS_DIR, filename), file.buffer);
    const fotoUrl = `/uploads/plants/${filename}`;
    return this.prisma.plant.update({ where: { id }, data: { fotoUrl } });
  }

  /** Histórico de diagnósticos já registrados para a planta (mais recente primeiro). */
  async findDiagnosisHistory(tenantId: string, projectId: string, id: string) {
    await this.findById(tenantId, projectId, id);
    const logs = await this.prisma.plantDiagnosisLog.findMany({
      where: { tenantId, projectId, plantId: id },
      orderBy: { createdAt: 'desc' },
    });
    return logs.map((log) => ({
      id: log.id,
      createdAt: log.createdAt,
      especiePopular: log.especiePopular,
      especieCientifica: log.especieCientifica,
      confiancaEspecie: log.confiancaEspecie,
      saudeStatus: log.saudeStatus,
      saudeConfianca: log.saudeConfianca,
      riscoPet: log.riscoPet,
      diagnosis: JSON.parse(log.diagnosisJson),
    }));
  }
}
