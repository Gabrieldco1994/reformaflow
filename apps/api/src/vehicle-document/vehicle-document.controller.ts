import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CreateVehicleDocumentDto,
  UpdateVehicleDocumentDto,
} from './dto/vehicle-document.dto';
import { VehicleDocumentService } from './vehicle-document.service';

@UseInterceptors(TenantInterceptor)
@RequireModule('vehicleDocuments')
@Controller('projects/:projectId/vehicle-documents')
export class VehicleDocumentController {
  constructor(private readonly service: VehicleDocumentService) {}

  @Get()
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findAll(tenantId, projectId);
  }

  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateVehicleDocumentDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateVehicleDocumentDto,
  ) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }

  @Post(':id/attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  addAttachment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { id: string },
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.addAttachment(
      tenantId,
      projectId,
      id,
      user.id,
      file,
    );
  }

  @Delete(':id/attachments/:attachmentId')
  removeAttachment(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.service.removeAttachment(
      tenantId,
      projectId,
      id,
      attachmentId,
    );
  }

  @Get(':id/attachments/:attachmentId/download')
  async downloadAttachment(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const attachment = await this.service.getAttachmentContent(
      tenantId,
      projectId,
      id,
      attachmentId,
    );
    return new StreamableFile(attachment.buffer, {
      type: attachment.mimeType,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    });
  }
}
