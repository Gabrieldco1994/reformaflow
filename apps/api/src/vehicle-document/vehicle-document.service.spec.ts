import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VehicleDocumentService } from './vehicle-document.service';

describe('VehicleDocumentService', () => {
  const existing = {
    id: 'doc-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    reminderId: 'reminder-1',
    tipo: 'SEGURO',
    titulo: 'Seguro 2027',
    numero: null,
    dataVencimento: new Date('2027-01-31T00:00:00.000Z'),
    lembreteAntecedenciaDias: 30,
    observacoes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  function makeService() {
    const prisma = {
      vehicleDocument: {
        findFirst: jest.fn().mockResolvedValue(existing),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue(existing),
      },
      reminder: {
        create: jest.fn().mockResolvedValue({ id: 'reminder-1' }),
        update: jest.fn().mockResolvedValue({ id: 'reminder-1' }),
        delete: jest.fn(),
      },
      attachment: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    return {
      service: new VehicleDocumentService(prisma as never),
      prisma,
    };
  }

  it('cria lembrete 30 dias antes e vincula ao documento', async () => {
    const { service, prisma } = makeService();

    await service.create('tenant-1', 'project-1', {
      tipo: 'SEGURO',
      titulo: 'Seguro 2027',
      dataVencimento: '2027-01-31',
    });

    expect(prisma.reminder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        generatedBy: 'VEHICLE_DOCUMENT',
        data: new Date('2027-01-01T00:00:00.000Z'),
      }),
    });
    expect(prisma.vehicleDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reminderId: 'reminder-1',
        dataVencimento: new Date('2027-01-31T00:00:00.000Z'),
        lembreteAntecedenciaDias: 30,
      }),
    });
  });

  it('sincroniza título, vencimento e antecedência no lembrete ao editar', async () => {
    const { service, prisma } = makeService();

    await service.update('tenant-1', 'project-1', 'doc-1', {
      titulo: 'Seguro renovado',
      dataVencimento: '2027-03-10',
      lembreteAntecedenciaDias: 15,
    });

    expect(prisma.reminder.update).toHaveBeenCalledWith({
      where: { id: 'reminder-1' },
      data: expect.objectContaining({
        titulo: 'Vencimento: Seguro renovado',
        data: new Date('2027-02-23T00:00:00.000Z'),
        status: 'PENDENTE',
      }),
    });
  });

  it('não permite acessar documento de outro tenant', async () => {
    const { service, prisma } = makeService();
    prisma.vehicleDocument.findFirst.mockResolvedValue(null);

    await expect(
      service.update('tenant-2', 'project-1', 'doc-1', { titulo: 'Inválido' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.vehicleDocument.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'doc-1',
        tenantId: 'tenant-2',
        projectId: 'project-1',
        deletedAt: null,
      },
    });
  });

  it('rejeita anexos fora dos formatos permitidos', async () => {
    const { service, prisma } = makeService();

    await expect(
      service.addAttachment('tenant-1', 'project-1', 'doc-1', 'user-1', {
        buffer: Buffer.from('x'),
        mimetype: 'text/plain',
        originalname: 'senha.txt',
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('não expõe a chave privada de armazenamento ao listar anexos', async () => {
    const { service, prisma } = makeService();
    prisma.vehicleDocument.findMany.mockResolvedValue([existing]);
    prisma.attachment.findMany.mockResolvedValue([
      {
        id: 'attachment-1',
        entityType: 'VEHICLE_DOCUMENT',
        entityId: 'doc-1',
        fileName: 'apolice.pdf',
        mimeType: 'application/pdf',
        url: 'private-key.pdf',
        uploadedBy: 'user-1',
        createdAt: new Date(),
        deletedAt: null,
      },
    ]);

    const result = await service.findAll('tenant-1', 'project-1');

    expect(result[0].attachments[0]).toEqual(
      expect.objectContaining({
        id: 'attachment-1',
        downloadUrl:
          '/projects/project-1/vehicle-documents/doc-1/attachments/attachment-1/download',
      }),
    );
    expect(result[0].attachments[0]).not.toHaveProperty('url');
  });

  it('rejeita arquivo cujo conteúdo não corresponde ao MIME declarado', async () => {
    const { service, prisma } = makeService();

    await expect(
      service.addAttachment('tenant-1', 'project-1', 'doc-1', 'user-1', {
        buffer: Buffer.from('conteúdo que não é PDF'),
        mimetype: 'application/pdf',
        originalname: 'falso.pdf',
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.attachment.create).not.toHaveBeenCalled();
  });
});
