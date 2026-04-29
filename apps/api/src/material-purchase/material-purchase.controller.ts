import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MaterialPurchaseService } from './material-purchase.service';
import { CreateMaterialPurchaseDto } from './dto/create-material-purchase.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('material-purchases')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/purchases')
export class MaterialPurchaseController {
  constructor(private readonly service: MaterialPurchaseService) {}

  @Post()
  @ApiOperation({ summary: 'Registrar compra de material' })
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateMaterialPurchaseDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar compras do projeto' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findAllByProject(tenantId, projectId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remover compra (soft delete)' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }
}
