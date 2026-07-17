import { Controller, Delete, Param, Post, Body, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TenantService } from './tenant.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';

@ApiTags('tenants')
@Controller('tenants')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Post()
  @ApiOperation({ summary: 'Criar novo tenant (registro de usuário)' })
  create(@Body() dto: CreateTenantDto) {
    return this.tenantService.create(dto);
  }

  @Delete(':id')
  @UseInterceptors(TenantInterceptor)
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Excluir tenant sem projetos (limpeza de contas de teste/órfãs)',
  })
  remove(@Param('id') id: string, @CurrentTenant() requesterTenantId: string) {
    return this.tenantService.remove(id, requesterTenantId);
  }
}
