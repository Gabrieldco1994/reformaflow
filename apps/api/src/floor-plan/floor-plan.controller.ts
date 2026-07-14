import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FloorPlanService } from './floor-plan.service';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { CurrentTenant } from '../common/decorators/tenant.decorator';

@UseInterceptors(TenantInterceptor)
@RequireModule('floorPlans')
@Controller('projects/:projectId/floor-plans')
export class FloorPlanController {
  constructor(private readonly service: FloorPlanService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  async create(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name?: string,
  ) {
    return this.service.create(projectId, tenantId, file, name);
  }

  @Get()
  async findAll(
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.findAll(projectId, tenantId);
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.findOne(id, projectId, tenantId);
  }

  @Post(':id/reanalyze')
  async reanalyze(
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.reanalyze(id, projectId, tenantId);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() body: { name?: string; cropBounds?: string | null },
  ) {
    return this.service.update(id, projectId, tenantId, body);
  }

  @Delete(':id')
  async delete(
    @Param('id') id: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.delete(id, projectId, tenantId);
  }

  // Floor plan room markers
  @Post(':id/rooms')
  async createRoom(
    @Param('id') floorPlanId: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() body: { label: string; bounds: string; color?: string; roomId?: string },
  ) {
    return this.service.createRoom(floorPlanId, projectId, tenantId, body);
  }

  @Patch('rooms/:roomMarkerId')
  async updateRoom(
    @Param('roomMarkerId') roomMarkerId: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body()
    body: { label?: string; bounds?: string; color?: string; roomId?: string | null },
  ) {
    return this.service.updateRoom(roomMarkerId, projectId, tenantId, body);
  }

  @Delete('rooms/:roomMarkerId')
  async deleteRoom(
    @Param('roomMarkerId') roomMarkerId: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.deleteRoom(roomMarkerId, projectId, tenantId);
  }

  // Room images
  @Post('room-images/:roomId')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async addRoomImage(
    @Param('projectId') projectId: string,
    @Param('roomId') roomId: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('caption') caption?: string,
  ) {
    return this.service.addRoomImage(projectId, roomId, tenantId, file, caption);
  }

  @Get('room-images/:roomId')
  async getRoomImages(
    @Param('projectId') projectId: string,
    @Param('roomId') roomId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.getRoomImages(projectId, roomId, tenantId);
  }

  @Delete('room-images/image/:imageId')
  async deleteRoomImage(
    @Param('projectId') projectId: string,
    @Param('imageId') imageId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.deleteRoomImage(projectId, imageId, tenantId);
  }

  // Markers (Raio-X)
  @Post(':id/markers')
  async createMarker(
    @Param('id') floorPlanId: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
    @Body() body: { expenseId: string; bounds: string },
  ) {
    return this.service.createMarker(floorPlanId, projectId, tenantId, body);
  }

  @Delete('markers/:markerId')
  async deleteMarker(
    @Param('markerId') markerId: string,
    @Param('projectId') projectId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.service.deleteMarker(markerId, projectId, tenantId);
  }
}
