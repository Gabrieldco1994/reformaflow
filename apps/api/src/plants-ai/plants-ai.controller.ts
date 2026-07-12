import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { PlantsAiService } from './plants-ai.service';

@ApiTags('plants-ai')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@RequireModule('plantsAi')
@Controller('projects/:projectId/plants-ai')
export class PlantsAiController {
  constructor(private readonly service: PlantsAiService) {}

  @Post('diagnose')
  @ApiOperation({ summary: 'Diagnosticar planta por foto com Gemini' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  diagnose(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.service.diagnose(tenantId, projectId, file);
  }

  @Post('diagnose-and-schedule')
  @ApiOperation({ summary: 'Diagnosticar e gerar cronograma automático de cuidados' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  diagnoseAndSchedule(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('persist') persistRaw?: string,
    @Body('plantId') plantId?: string,
    @Body('nome') nome?: string,
  ) {
    const persist = persistRaw === undefined ? true : persistRaw !== 'false';
    return this.service.diagnoseAndSchedule(tenantId, projectId, file, persist, plantId, nome);
  }

  @Get(':plantId/insights')
  @ApiOperation({ summary: 'Obter diagnóstico e cronograma de cuidados de uma planta' })
  getPlantInsights(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('plantId') plantId: string,
  ) {
    return this.service.getPlantInsights(tenantId, projectId, plantId);
  }
}
