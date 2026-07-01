import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import {
  UpsertScheduleConfigDto,
  CreateScheduleStageDto,
  UpdateScheduleStageDto,
  CreateScheduleTaskDto,
  UpdateScheduleTaskDto,
  CreateScheduleHolidayDto,
  ImportScheduleDto,
} from './dto/schedule.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@UseInterceptors(TenantInterceptor)
@RequireModule('schedule')
@Controller('projects/:projectId/schedule')
export class ScheduleController {
  constructor(private readonly service: ScheduleService) {}

  // ─── Config ───────────────────────────────────────────
  @Get('config')
  getConfig(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.getConfig(projectId, tenantId);
  }

  @Put('config')
  upsertConfig(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpsertScheduleConfigDto,
  ) {
    return this.service.upsertConfig(projectId, tenantId, dto);
  }

  // ─── Stages ───────────────────────────────────────────
  @Get('stages')
  getStages(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.getStages(projectId, tenantId);
  }

  @Post('stages')
  createStage(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: CreateScheduleStageDto,
  ) {
    return this.service.createStage(projectId, tenantId, dto);
  }

  @Patch('stages/:stageId')
  updateStage(
    @Param('stageId') stageId: string,
    @Body() dto: UpdateScheduleStageDto,
  ) {
    return this.service.updateStage(stageId, dto);
  }

  @Delete('stages/:stageId')
  deleteStage(@Param('stageId') stageId: string) {
    return this.service.deleteStage(stageId);
  }

  // ─── Tasks ────────────────────────────────────────────
  @Get('tasks')
  getTasks(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.getTasks(projectId, tenantId);
  }

  @Post('tasks')
  createTask(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: CreateScheduleTaskDto,
  ) {
    return this.service.createTask(projectId, tenantId, dto);
  }

  @Patch('tasks/:taskId')
  updateTask(
    @Param('taskId') taskId: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateScheduleTaskDto,
  ) {
    return this.service.updateTask(taskId, projectId, tenantId, dto);
  }

  @Delete('tasks/:taskId')
  deleteTask(
    @Param('taskId') taskId: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.deleteTask(taskId, projectId, tenantId);
  }

  // ─── Holidays ─────────────────────────────────────────
  @Get('holidays')
  getHolidays(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.getHolidays(projectId, tenantId);
  }

  @Post('holidays')
  createHoliday(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: CreateScheduleHolidayDto,
  ) {
    return this.service.createHoliday(projectId, tenantId, dto);
  }

  @Delete('holidays/:holidayId')
  deleteHoliday(
    @Param('holidayId') holidayId: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.deleteHoliday(holidayId, projectId, tenantId);
  }

  // ─── Gantt ────────────────────────────────────────────
  @Get('gantt')
  getGanttData(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.getGanttData(projectId, tenantId);
  }

  // ─── Import ───────────────────────────────────────────
  @Post('import')
  importSchedule(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: ImportScheduleDto,
  ) {
    return this.service.importSchedule(projectId, tenantId, dto);
  }
}
