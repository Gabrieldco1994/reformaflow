import { Module } from '@nestjs/common';
import { VehicleDocumentController } from './vehicle-document.controller';
import { VehicleDocumentService } from './vehicle-document.service';

@Module({
  controllers: [VehicleDocumentController],
  providers: [VehicleDocumentService],
})
export class VehicleDocumentModule {}
