import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CarInfoService } from './car-info.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertCarInfoDto } from './dto/car-info.dto';

describe('CarInfoService', () => {
  let service: CarInfoService;
  let prisma: PrismaService;

  const tenantA = 'tenant-a-id';
  const tenantB = 'tenant-b-id';

  const projectA_TenantA = 'project-a-tenant-a-id';
  const projectB_TenantB = 'project-b-tenant-b-id';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarInfoService,
        {
          provide: PrismaService,
          useValue: {
            project: {
              findFirst: jest.fn(),
            },
            carInfo: {
              findFirst: jest.fn(),
              upsert: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<CarInfoService>(CarInfoService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('should return carInfo when tenant owns the project', async () => {
      const carInfo = {
        id: 'car-info-1',
        projectId: projectA_TenantA,
        tenantId: tenantA,
        marca: 'Toyota',
        modelo: 'Corolla',
        anoFabricacao: 2020,
        anoModelo: 2020,
        cor: 'Preto',
        placa: 'ABC1234',
        tabelaFipe: 95000,
        valorPago: 100000,
        kmAtual: 50000,
        kmUltimaRevisao: 40000,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectA_TenantA,
        tenantId: tenantA,
      });

      (prisma.carInfo.findFirst as jest.Mock).mockResolvedValue(carInfo);

      const result = await service.get(tenantA, projectA_TenantA);

      expect(result).toEqual(carInfo);
      expect(prisma.project.findFirst).toHaveBeenCalledWith({
        where: { id: projectA_TenantA, tenantId: tenantA, deletedAt: null },
      });
      expect(prisma.carInfo.findFirst).toHaveBeenCalledWith({
        where: { projectId: projectA_TenantA },
      });
    });

    it('should throw NotFoundException when tenant B tries to read carInfo of tenant A project', async () => {
      // Tenant B tries to read project that belongs to Tenant A
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.get(tenantB, projectA_TenantA),
      ).rejects.toThrow(NotFoundException);

      // Verify carInfo was NOT queried (security boundary enforced early)
      expect(prisma.carInfo.findFirst).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when project does not exist', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.get(tenantA, 'non-existent-project'),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.carInfo.findFirst).not.toHaveBeenCalled();
    });

    it('should return null when carInfo does not exist for valid project', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectA_TenantA,
        tenantId: tenantA,
      });

      (prisma.carInfo.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.get(tenantA, projectA_TenantA);

      expect(result).toBeNull();
    });
  });

  describe('upsert', () => {
    const dto: UpsertCarInfoDto = {
      marca: 'Honda',
      modelo: 'Civic',
      anoFabricacao: 2021,
      anoModelo: 2021,
      cor: 'Branco',
      placa: 'XYZ5678',
      tabelaFipe: 110000,
      valorPago: 120000,
      kmAtual: 30000,
      kmUltimaRevisao: 20000,
    };

    it('should create carInfo when tenant owns the project', async () => {
      const createdCarInfo = {
        id: 'car-info-2',
        projectId: projectA_TenantA,
        tenantId: tenantA,
        ...dto,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectA_TenantA,
        tenantId: tenantA,
      });

      (prisma.carInfo.upsert as jest.Mock).mockResolvedValue(createdCarInfo);

      const result = await service.upsert(tenantA, projectA_TenantA, dto);

      expect(result).toEqual(createdCarInfo);
      expect(prisma.project.findFirst).toHaveBeenCalledWith({
        where: { id: projectA_TenantA, tenantId: tenantA, deletedAt: null },
      });
      expect(prisma.carInfo.upsert).toHaveBeenCalledWith({
        where: { projectId: projectA_TenantA },
        create: {
          tenantId: tenantA,
          projectId: projectA_TenantA,
          ...dto,
        },
        update: dto,
      });
    });

    it('should throw NotFoundException when tenant B tries to write carInfo to tenant A project', async () => {
      // Tenant B tries to write to project that belongs to Tenant A
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.upsert(tenantB, projectA_TenantA, dto),
      ).rejects.toThrow(NotFoundException);

      // Verify upsert was NOT executed (security boundary enforced early)
      expect(prisma.carInfo.upsert).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when upserting to non-existent project', async () => {
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.upsert(tenantA, 'non-existent-project', dto),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.carInfo.upsert).not.toHaveBeenCalled();
    });

    it('should update existing carInfo when tenant owns the project', async () => {
      const existingCarInfo = {
        id: 'car-info-1',
        projectId: projectA_TenantA,
        tenantId: tenantA,
        marca: 'Toyota',
        modelo: 'Corolla',
        anoFabricacao: 2020,
        anoModelo: 2020,
        cor: 'Preto',
        placa: 'ABC1234',
        tabelaFipe: 95000,
        valorPago: 100000,
        kmAtual: 50000,
        kmUltimaRevisao: 40000,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedCarInfo = {
        ...existingCarInfo,
        ...dto,
        updatedAt: new Date(),
      };

      (prisma.project.findFirst as jest.Mock).mockResolvedValue({
        id: projectA_TenantA,
        tenantId: tenantA,
      });

      (prisma.carInfo.upsert as jest.Mock).mockResolvedValue(updatedCarInfo);

      const result = await service.upsert(tenantA, projectA_TenantA, dto);

      expect(result).toEqual(updatedCarInfo);
      expect(prisma.carInfo.upsert).toHaveBeenCalled();
    });
  });

  describe('Tenant isolation — integration scenarios', () => {
    it('should prevent cross-tenant data leakage in get() path', async () => {
      // Setup: Tenant A has project A with carInfo
      const carInfoA = {
        id: 'car-info-a',
        projectId: projectA_TenantA,
        tenantId: tenantA,
        marca: 'Toyota',
      };

      // Attacker: Tenant B guesses projectId and tries to read carInfo directly
      (prisma.project.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: projectA_TenantA, tenantId: tenantA }) // valid call
        .mockResolvedValueOnce(null); // tenant B trying to read tenant A's project

      // Tenant A can read their own carInfo
      const validRead = await service.get(tenantA, projectA_TenantA);
      expect(prisma.carInfo.findFirst).toHaveBeenCalled();

      // Reset mock
      jest.clearAllMocks();
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(null);

      // Tenant B is rejected BEFORE carInfo.findFirst is called
      await expect(
        service.get(tenantB, projectA_TenantA),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.carInfo.findFirst).not.toHaveBeenCalled();
    });

    it('should prevent cross-tenant data mutation in upsert() path', async () => {
      const dto: UpsertCarInfoDto = { marca: 'Ford' };

      // Attacker: Tenant B tries to overwrite Tenant A's carInfo
      (prisma.project.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.upsert(tenantB, projectA_TenantA, dto),
      ).rejects.toThrow(NotFoundException);

      // Verify mutation was blocked (upsert never called)
      expect(prisma.carInfo.upsert).not.toHaveBeenCalled();
    });
  });
});
