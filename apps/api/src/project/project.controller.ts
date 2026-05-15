import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProjectService } from './project.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { Roles } from '../common/decorators/roles.decorator';

interface RequestUser {
  role: string;
  allowedModules: string[];
}

@ApiTags('projects')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  @ApiOperation({ summary: 'Criar novo projeto com ambientes padrão' })
  create(
    @CurrentTenant() tenantId: string,
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.projectService.create(tenantId, dto, user);
  }

  @Get()
  @ApiOperation({ summary: 'Listar projetos do tenant' })
  findAll(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.projectService.findAll(tenantId, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Buscar projeto por ID' })
  findOne(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.projectService.findById(tenantId, id, user);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Atualizar projeto' })
  update(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Remover projeto (soft delete)' })
  remove(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.projectService.remove(tenantId, id);
  }
}
