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
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('projects')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  @ApiOperation({ summary: 'Criar novo projeto com ambientes padrão' })
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateProjectDto) {
    return this.projectService.create(tenantId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar projetos do tenant' })
  findAll(@CurrentTenant() tenantId: string) {
    return this.projectService.findAll(tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Buscar projeto por ID' })
  findOne(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.projectService.findById(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualizar projeto' })
  update(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remover projeto (soft delete)' })
  remove(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.projectService.remove(tenantId, id);
  }
}
