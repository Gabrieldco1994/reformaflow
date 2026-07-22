import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VehicleDocument } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateVehicleDocumentDto,
  UpdateVehicleDocumentDto,
} from './dto/vehicle-document.dto';

const ENTITY_TYPE = 'VEHICLE_DOCUMENT';
const ALLOWED_MIME_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function hasExpectedSignature(mimeType: string, buffer: Buffer): boolean {
  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 4).toString() === '%PDF';
  }
  if (mimeType === 'image/jpeg') {
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }
  if (mimeType === 'image/png') {
    return buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buffer.subarray(0, 4).toString() === 'RIFF' &&
      buffer.subarray(8, 12).toString() === 'WEBP'
    );
  }
  return false;
}

const PRIVATE_UPLOADS_ROOT = (() => {
  const raw = process.env['PRIVATE_UPLOADS_DIR'];
  if (raw) return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  const publicRaw = process.env['UPLOADS_DIR'];
  const publicRoot = publicRaw
    ? path.isAbsolute(publicRaw)
      ? publicRaw
      : path.join(process.cwd(), publicRaw)
    : path.join(process.cwd(), 'uploads');
  return path.join(path.dirname(publicRoot), 'private-uploads');
})();
const UPLOADS_DIR = path.join(PRIVATE_UPLOADS_ROOT, 'vehicle-documents');

function parseDateOnlyUtc(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function reminderDate(dueDate: Date, daysBefore: number): Date {
  const date = new Date(dueDate);
  date.setUTCDate(date.getUTCDate() - daysBefore);
  return date;
}

@Injectable()
export class VehicleDocumentService {
  constructor(private readonly prisma: PrismaService) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  async findAll(tenantId: string, projectId: string) {
    const documents = await this.prisma.vehicleDocument.findMany({
      where: { tenantId, projectId, deletedAt: null },
      orderBy: { dataVencimento: 'asc' },
    });
    return this.withAttachments(documents);
  }

  async create(
    tenantId: string,
    projectId: string,
    dto: CreateVehicleDocumentDto,
  ) {
    const dueDate = parseDateOnlyUtc(dto.dataVencimento);
    const daysBefore = dto.lembreteAntecedenciaDias ?? 30;

    return this.prisma.$transaction(async (tx) => {
      const reminder = await tx.reminder.create({
        data: {
          tenantId,
          projectId,
          generatedBy: ENTITY_TYPE,
          titulo: `Vencimento: ${dto.titulo}`,
          descricao: `Documento do veículo: ${dto.tipo}`,
          data: reminderDate(dueDate, daysBefore),
          recorrencia: 'UNICA',
          prioridade: 'ALTA',
        },
      });
      return tx.vehicleDocument.create({
        data: {
          tenantId,
          projectId,
          reminderId: reminder.id,
          tipo: dto.tipo,
          titulo: dto.titulo,
          numero: dto.numero?.trim() || null,
          dataVencimento: dueDate,
          lembreteAntecedenciaDias: daysBefore,
          observacoes: dto.observacoes?.trim() || null,
        },
      });
    });
  }

  async update(
    tenantId: string,
    projectId: string,
    id: string,
    dto: UpdateVehicleDocumentDto,
  ) {
    const existing = await this.findOne(tenantId, projectId, id);
    const dueDate = dto.dataVencimento
      ? parseDateOnlyUtc(dto.dataVencimento)
      : existing.dataVencimento;
    const daysBefore =
      dto.lembreteAntecedenciaDias ??
      existing.lembreteAntecedenciaDias;
    const title = dto.titulo ?? existing.titulo;
    const type = dto.tipo ?? existing.tipo;

    return this.prisma.$transaction(async (tx) => {
      let reminderId = existing.reminderId;
      if (reminderId) {
        await tx.reminder.update({
          where: { id: reminderId },
          data: {
            titulo: `Vencimento: ${title}`,
            descricao: `Documento do veículo: ${type}`,
            data: reminderDate(dueDate, daysBefore),
            status: 'PENDENTE',
          },
        });
      } else {
        const reminder = await tx.reminder.create({
          data: {
            tenantId,
            projectId,
            generatedBy: ENTITY_TYPE,
            titulo: `Vencimento: ${title}`,
            descricao: `Documento do veículo: ${type}`,
            data: reminderDate(dueDate, daysBefore),
            recorrencia: 'UNICA',
            prioridade: 'ALTA',
          },
        });
        reminderId = reminder.id;
      }

      return tx.vehicleDocument.update({
        where: { id },
        data: {
          reminderId,
          tipo: dto.tipo,
          titulo: dto.titulo,
          numero:
            dto.numero !== undefined ? dto.numero.trim() || null : undefined,
          dataVencimento: dto.dataVencimento ? dueDate : undefined,
          lembreteAntecedenciaDias: dto.lembreteAntecedenciaDias,
          observacoes:
            dto.observacoes !== undefined
              ? dto.observacoes.trim() || null
              : undefined,
        },
      });
    });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    const existing = await this.findOne(tenantId, projectId, id);
    const attachments = await this.prisma.attachment.findMany({
      where: { entityType: ENTITY_TYPE, entityId: id, deletedAt: null },
    });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.attachment.updateMany({
        where: { entityType: ENTITY_TYPE, entityId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await tx.vehicleDocument.update({
        where: { id },
        data: { deletedAt: new Date(), reminderId: null },
      });
      if (existing.reminderId) {
        await tx.reminder.delete({ where: { id: existing.reminderId } });
      }
      return { deleted: true };
    });
    for (const attachment of attachments) {
      this.deleteStoredFile(attachment.url);
    }
    return result;
  }

  async addAttachment(
    tenantId: string,
    projectId: string,
    id: string,
    userId: string,
    file: Express.Multer.File | undefined,
  ) {
    await this.findOne(tenantId, projectId, id);
    if (!file?.buffer) {
      throw new BadRequestException(
        'Arquivo não enviado (campo "file" obrigatório)',
      );
    }
    const extension = ALLOWED_MIME_TYPES[file.mimetype];
    if (!extension) {
      throw new BadRequestException(
        'Formato inválido. Envie PDF, JPG, PNG ou WebP.',
      );
    }
    if (!hasExpectedSignature(file.mimetype, file.buffer)) {
      throw new BadRequestException(
        'O conteúdo do arquivo não corresponde ao formato informado.',
      );
    }

    const fileName = `${randomUUID()}${extension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);
    fs.writeFileSync(filePath, file.buffer);

    try {
      const attachment = await this.prisma.attachment.create({
        data: {
          entityType: ENTITY_TYPE,
          entityId: id,
          fileName: file.originalname,
          mimeType: file.mimetype,
          url: fileName,
          uploadedBy: userId,
        },
      });
      return {
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        uploadedBy: attachment.uploadedBy,
        createdAt: attachment.createdAt,
        downloadUrl: `/projects/${projectId}/vehicle-documents/${id}/attachments/${attachment.id}/download`,
      };
    } catch (error) {
      fs.rmSync(filePath, { force: true });
      throw error;
    }
  }

  async removeAttachment(
    tenantId: string,
    projectId: string,
    id: string,
    attachmentId: string,
  ) {
    await this.findOne(tenantId, projectId, id);
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        entityType: ENTITY_TYPE,
        entityId: id,
        deletedAt: null,
      },
    });
    if (!attachment) {
      throw new NotFoundException('Anexo não encontrado');
    }
    await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: { deletedAt: new Date() },
    });
    this.deleteStoredFile(attachment.url);
    return { deleted: true };
  }

  async getAttachmentContent(
    tenantId: string,
    projectId: string,
    id: string,
    attachmentId: string,
  ) {
    await this.findOne(tenantId, projectId, id);
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        entityType: ENTITY_TYPE,
        entityId: id,
        deletedAt: null,
      },
    });
    if (!attachment) {
      throw new NotFoundException('Anexo não encontrado');
    }
    const filePath = this.storedFilePath(attachment.url);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Arquivo do anexo não encontrado');
    }
    return {
      buffer: fs.readFileSync(filePath),
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
    };
  }

  private async findOne(
    tenantId: string,
    projectId: string,
    id: string,
  ): Promise<VehicleDocument> {
    const document = await this.prisma.vehicleDocument.findFirst({
      where: { id, tenantId, projectId, deletedAt: null },
    });
    if (!document) {
      throw new NotFoundException('Documento do veículo não encontrado');
    }
    return document;
  }

  private async withAttachments(documents: VehicleDocument[]) {
    if (documents.length === 0) return [];
    const attachments = await this.prisma.attachment.findMany({
      where: {
        entityType: ENTITY_TYPE,
        entityId: { in: documents.map((document) => document.id) },
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
    const byDocument = new Map<string, typeof attachments>();
    for (const attachment of attachments) {
      const current = byDocument.get(attachment.entityId) ?? [];
      current.push(attachment);
      byDocument.set(attachment.entityId, current);
    }
    return documents.map((document) => ({
      ...document,
      attachments: (byDocument.get(document.id) ?? []).map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        uploadedBy: attachment.uploadedBy,
        createdAt: attachment.createdAt,
        downloadUrl: `/projects/${document.projectId}/vehicle-documents/${document.id}/attachments/${attachment.id}/download`,
      })),
    }));
  }

  private storedFilePath(storageKey: string): string {
    if (path.basename(storageKey) !== storageKey) {
      throw new BadRequestException('Caminho de anexo inválido');
    }
    return path.join(UPLOADS_DIR, storageKey);
  }

  private deleteStoredFile(storageKey: string): void {
    fs.rmSync(this.storedFilePath(storageKey), { force: true });
  }
}
