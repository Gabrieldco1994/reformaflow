import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ContractorService } from './contractor.service';
import { CreateContractorDto } from './dto/create-contractor.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@ApiTags('contractors')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/contractors')
export class ContractorController {
  constructor(private readonly service: ContractorService) {}

  @Post()
  @ApiOperation({ summary: 'Cadastrar empreiteiro com 4 milestones padrão' })
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateContractorDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar empreiteiros com milestones e valores liberados' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.getSummary(tenantId, projectId);
  }

  @Patch('milestones/:milestoneId')
  @ApiOperation({ summary: 'Atualizar milestone (% concluído, pagamento)' })
  updateMilestone(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('milestoneId') milestoneId: string,
    @Body() dto: UpdateMilestoneDto,
  ) {
    return this.service.updateMilestone(tenantId, projectId, milestoneId, dto);
  }
}
