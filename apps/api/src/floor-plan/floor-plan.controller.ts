import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Headers,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FloorPlanService } from './floor-plan.service';
import { RequireModule } from '../common/decorators/require-module.decorator';

@RequireModule('floorPlans')
@Controller('projects/:projectId/floor-plans')
export class FloorPlanController {
  constructor(private readonly service: FloorPlanService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async create(
    @Param('projectId') projectId: string,
    @Headers('x-tenant-id') tenantId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name?: string,
  ) {
    return this.service.create(projectId, tenantId, file, name);
  }

  @Get()
  async findAll(
    @Param('projectId') projectId: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    return this.service.findAll(projectId, tenantId);
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    return this.service.findOne(id, tenantId);
  }

  @Post(':id/reanalyze')
  async reanalyze(
    @Param('id') id: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    return this.service.reanalyze(id, tenantId);
  }

  @Delete(':id')
  async delete(
    @Param('id') id: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    return this.service.delete(id, tenantId);
  }

  // Floor plan room markers
  @Post(':id/rooms')
  async createRoom(
    @Param('id') floorPlanId: string,
    @Body() body: { label: string; bounds: string; color?: string; roomId?: string },
  ) {
    return this.service.createRoom(floorPlanId, body);
  }

  @Patch('rooms/:roomMarkerId')
  async updateRoom(
    @Param('roomMarkerId') roomMarkerId: string,
    @Body()
    body: { label?: string; bounds?: string; color?: string; roomId?: string | null },
  ) {
    return this.service.updateRoom(roomMarkerId, body);
  }

  @Delete('rooms/:roomMarkerId')
  async deleteRoom(@Param('roomMarkerId') roomMarkerId: string) {
    return this.service.deleteRoom(roomMarkerId);
  }

  // Room images
  @Post('room-images/:roomId')
  @UseInterceptors(FileInterceptor('file'))
  async addRoomImage(
    @Param('roomId') roomId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('caption') caption?: string,
  ) {
    return this.service.addRoomImage(roomId, file, caption);
  }

  @Get('room-images/:roomId')
  async getRoomImages(@Param('roomId') roomId: string) {
    return this.service.getRoomImages(roomId);
  }

  @Delete('room-images/image/:imageId')
  async deleteRoomImage(@Param('imageId') imageId: string) {
    return this.service.deleteRoomImage(imageId);
  }
}
