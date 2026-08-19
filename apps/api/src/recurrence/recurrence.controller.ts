import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RecurrenceService } from './recurrence.service';
import { UpdateRecurrenceDto } from './dto/update-recurrence.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { RateioRequester } from '../expense/rateio.types';

@ApiTags('recurrences')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
// Gate por 'expenses', não por 'recurrences': a permissão do usuário é uma lista
// PERSISTIDA no signup, e quem já tem conta não teria 'recurrences' — tomaria 403.
// Não há exposição nova de dado: uma recorrência é uma leitura derivada das
// despesas que o usuário já pode ler. 'recurrences' segue em TYPE_MODULES /
// PROJECT_FEATURES para gatear a navegação por tipo de projeto.
@RequireModule('expenses')
@Controller('projects/:projectId/recurrences')
export class RecurrenceController {
  constructor(private readonly service: RecurrenceService) {}

  @Get()
  @ApiOperation({ summary: 'Listar despesas recorrentes detectadas no projeto' })
  list(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.list(tenantId, projectId);
  }

  @Patch(':key')
  @ApiOperation({ summary: 'Editar a série (aplica só às ocorrências futuras)' })
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('key') key: string,
    @Body() dto: UpdateRecurrenceDto,
    @CurrentUser() requester: RateioRequester,
  ) {
    return this.service.update(tenantId, projectId, key, dto, requester);
  }

  @Delete(':key')
  @ApiOperation({ summary: 'Excluir a série (apaga só as ocorrências futuras)' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('key') key: string,
    @CurrentUser() requester: RateioRequester,
  ) {
    return this.service.remove(tenantId, projectId, key, requester);
  }
}
