import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards, Req } from '@nestjs/common';
import { BudgetAllocationService } from './budget-allocation.service';
import { CreateBudgetAllocationDto } from './dto/create-budget-allocation.dto';
import { UpdateBudgetAllocationDto } from './dto/update-budget-allocation.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('budget-allocations')
@UseGuards(JwtAuthGuard)
export class BudgetAllocationController {
  constructor(private readonly budgetAllocationService: BudgetAllocationService) {}

  @Post()
  create(
    @Body() createDto: CreateBudgetAllocationDto,
    @Query('sourceProjectId') sourceProjectId: string,
    @Req() req: any,
  ) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.create(sourceProjectId, tenantId, createDto);
  }

  @Get()
  findAll(
    @Query('sourceProjectId') sourceProjectId: string,
    @Query('targetProjectId') targetProjectId: string,
    @Query('mes') mes: string,
    @Req() req: any,
  ) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.findAll(tenantId, {
      sourceProjectId,
      targetProjectId,
      mes,
    });
  }

  @Get('summary/:projectId')
  getSummary(@Param('projectId') projectId: string, @Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.getSummary(projectId, tenantId);
  }

  @Get('available/:projectId')
  getAvailable(@Param('projectId') projectId: string, @Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.calculateAvailableBudget(projectId, tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.findOne(id, tenantId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateDto: UpdateBudgetAllocationDto, @Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.update(id, tenantId, updateDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.budgetAllocationService.remove(id, tenantId);
  }
}
