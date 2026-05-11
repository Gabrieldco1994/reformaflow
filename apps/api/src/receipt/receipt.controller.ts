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
import { ReceiptService } from './receipt.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { UpdateReceiptDto } from './dto/update-receipt.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('receipts')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/receipts')
export class ReceiptController {
  constructor(private readonly service: ReceiptService) {}

  @Post()
  @ApiOperation({ summary: 'Criar recebimento' })
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateReceiptDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar recebimentos do projeto' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findAllByProject(tenantId, projectId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualizar recebimento' })
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateReceiptDto,
  ) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remover recebimento (soft delete)' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }
}
