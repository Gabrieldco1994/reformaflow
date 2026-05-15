import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Headers,
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

@RequireModule('schedule')
@Controller('projects/:projectId/schedule')
export class ScheduleController {
  constructor(private readonly service: ScheduleService) {}

  private getTenantId(headers: Record<string, string>): string {
    return headers['x-tenant-id'] || 'dev-tenant-1';
  }

  // ─── Config ───────────────────────────────────────────
  @Get('config')
  getConfig(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
  ) {
    return this.service.getConfig(projectId, this.getTenantId(headers));
  }

  @Put('config')
  upsertConfig(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
    @Body() dto: UpsertScheduleConfigDto,
  ) {
    return this.service.upsertConfig(projectId, this.getTenantId(headers), dto);
  }

  // ─── Stages ───────────────────────────────────────────
  @Get('stages')
  getStages(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
  ) {
    return this.service.getStages(projectId, this.getTenantId(headers));
  }

  @Post('stages')
  createStage(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
    @Body() dto: CreateScheduleStageDto,
  ) {
    return this.service.createStage(projectId, this.getTenantId(headers), dto);
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
    @Headers() headers: Record<string, string>,
  ) {
    return this.service.getTasks(projectId, this.getTenantId(headers));
  }

  @Post('tasks')
  createTask(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
    @Body() dto: CreateScheduleTaskDto,
  ) {
    return this.service.createTask(projectId, this.getTenantId(headers), dto);
  }

  @Patch('tasks/:taskId')
  updateTask(
    @Param('taskId') taskId: string,
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
    @Body() dto: UpdateScheduleTaskDto,
  ) {
    return this.service.updateTask(taskId, projectId, this.getTenantId(headers), dto);
  }

  @Delete('tasks/:taskId')
  deleteTask(
    @Param('taskId') taskId: string,
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
  ) {
    return this.service.deleteTask(taskId, projectId, this.getTenantId(headers));
  }

  // ─── Holidays ─────────────────────────────────────────
  @Get('holidays')
  getHolidays(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
  ) {
    return this.service.getHolidays(projectId, this.getTenantId(headers));
  }

  @Post('holidays')
  createHoliday(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
    @Body() dto: CreateScheduleHolidayDto,
  ) {
    return this.service.createHoliday(projectId, this.getTenantId(headers), dto);
  }

  @Delete('holidays/:holidayId')
  deleteHoliday(
    @Param('holidayId') holidayId: string,
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
  ) {
    return this.service.deleteHoliday(holidayId, projectId, this.getTenantId(headers));
  }

  // ─── Gantt ────────────────────────────────────────────
  @Get('gantt')
  getGanttData(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
  ) {
    return this.service.getGanttData(projectId, this.getTenantId(headers));
  }

  // ─── Import ───────────────────────────────────────────
  @Post('import')
  importSchedule(
    @Param('projectId') projectId: string,
    @Headers() headers: Record<string, string>,
    @Body() dto: ImportScheduleDto,
  ) {
    return this.service.importSchedule(projectId, this.getTenantId(headers), dto);
  }
}
