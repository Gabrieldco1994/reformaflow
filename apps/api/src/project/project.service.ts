import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { defaultRooms } from '@reformaflow/domain';
import {
  userCanAccessProjectType,
  userCanAccessProject,
  userCanCreateProjectType,
  isFullAccessRole,
} from '../common/access-rules';

interface RequestUser {
  id?: string;
  role: string;
  allowedModules: string[];
  allowedProjects?: string[];
  allowedProjectTypes?: string[];
}

@Injectable()
export class ProjectService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateProjectDto, user?: RequestUser) {
    if (user && !isFullAccessRole(user.role)) {
      if (
        !userCanCreateProjectType(
          user.role,
          user.allowedProjectTypes,
          user.allowedModules ?? [],
          dto.type,
        )
      ) {
        throw new ForbiddenException(
          `Sem permissão para criar projetos do tipo "${dto.type}"`,
        );
      }
    }

    const projectId = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          tenantId,
          createdByUserId: user?.id ?? null,
          type: dto.type,
          name: dto.name,
          description: dto.description,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
        },
      });

      // Criar ambientes padrão apenas para projetos de REFORMA
      if (dto.type === 'REFORMA') {
        for (let i = 0; i < defaultRooms.length; i++) {
          await tx.room.create({
            data: {
              projectId: project.id,
              name: defaultRooms[i]!,
              order: i,
            },
          });
        }
      }

      return project.id;
    });

    // Associação direta: se o criador é restrito a projetos específicos,
    // concede acesso ao projeto recém-criado (senão ele não veria o que criou).
    // Lê o estado fresco do usuário numa transação para evitar lost-update em
    // criações concorrentes (o snapshot do request pode estar desatualizado).
    if (
      user?.id &&
      !isFullAccessRole(user.role) &&
      (user.allowedProjects ?? []).length > 0
    ) {
      const userId = user.id;
      await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.user.findUnique({
          where: { id: userId },
          select: { allowedProjects: true },
        });
        if (!fresh) return;
        let current: string[] = [];
        try {
          const parsed = JSON.parse(fresh.allowedProjects || '[]');
          if (Array.isArray(parsed)) current = parsed;
        } catch {
          current = [];
        }
        // Lista vazia = sem restrição: não converter em restrita por engano.
        if (current.length === 0 || current.includes(projectId)) return;
        await tx.user.update({
          where: { id: userId },
          data: { allowedProjects: JSON.stringify([...current, projectId]) },
        });
      });
    }

    return this.findByIdInternal(tenantId, projectId);
  }

  async findAll(tenantId: string, user?: RequestUser) {
    const projects = await this.prisma.project.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    if (!user || isFullAccessRole(user.role)) return projects;

    return projects.filter(
      (p) =>
        userCanAccessProjectType(
          user.role,
          user.allowedProjectTypes,
          user.allowedModules ?? [],
          p.type,
        ) && userCanAccessProject(user.role, user.allowedProjects, p.id),
    );
  }

  async findById(tenantId: string, id: string, user?: RequestUser) {
    const project = await this.findByIdInternal(tenantId, id);

    if (user && !isFullAccessRole(user.role)) {
      if (
        !userCanAccessProjectType(
          user.role,
          user.allowedProjectTypes,
          user.allowedModules ?? [],
          project.type,
        )
      ) {
        throw new ForbiddenException(
          `Sem permissão para acessar projetos do tipo "${project.type}"`,
        );
      }
      if (!userCanAccessProject(user.role, user.allowedProjects, project.id)) {
        throw new ForbiddenException('Sem permissão para acessar este projeto');
      }
    }

    return project;
  }

  private async findByIdInternal(tenantId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, tenantId },
      include: {
        rooms: { orderBy: { order: 'asc' } },
        _count: { select: { receipts: true, expenses: true, cashFlow: true } },
      },
    });

    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  async update(tenantId: string, id: string, dto: UpdateProjectDto) {
    await this.findByIdInternal(tenantId, id);
    return this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.type && { type: dto.type }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.startDate !== undefined && {
          startDate: dto.startDate ? new Date(dto.startDate) : null,
        }),
        ...(dto.endDate !== undefined && {
          endDate: dto.endDate ? new Date(dto.endDate) : null,
        }),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findByIdInternal(tenantId, id);
    await this.prisma.project.delete({ where: { id } });
    return { deleted: true };
  }
}
