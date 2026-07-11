import { Controller, Get, Post, Patch, Delete, Param, Body, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PlantService } from './plant.service';
import { CreatePlantDto, UpdatePlantDto } from './dto/plant.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@UseInterceptors(TenantInterceptor)
@RequireModule('plantsAi')
@Controller('projects/:projectId/plants')
export class PlantController {
  constructor(private readonly service: PlantService) {}

  @Get()
  findAll(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.findAll(tenantId, projectId);
  }

  @Get(':id')
  findOne(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.findById(tenantId, projectId, id);
  }

  @Get(':id/diagnosticos')
  findDiagnosisHistory(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.findDiagnosisHistory(tenantId, projectId, id);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Body() dto: CreatePlantDto) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePlantDto,
  ) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.service.remove(tenantId, projectId, id);
  }

  @Post(':id/foto')
  @UseInterceptors(FileInterceptor('file'))
  setPhoto(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.setPhoto(tenantId, projectId, id, file);
  }
}
