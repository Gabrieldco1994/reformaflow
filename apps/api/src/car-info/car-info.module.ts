import { Module } from '@nestjs/common';
import { CarInfoController } from './car-info.controller';
import { CarInfoService } from './car-info.service';

@Module({
  controllers: [CarInfoController],
  providers: [CarInfoService],
})
export class CarInfoModule {}
