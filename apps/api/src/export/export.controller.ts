import { Controller, Get, Param, Res, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { ExportService } from './export.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('export')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/export')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get('excel')
  @ApiOperation({ summary: 'Exportar projeto como Excel (compatível com planilha original)' })
  async exportExcel(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Res() res: Response,
  ) {
    const buffer = await this.exportService.generateExcel(tenantId, projectId);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Controle_Reforma_${projectId}.xlsx"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }
}
