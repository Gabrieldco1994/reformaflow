import { Module } from '@nestjs/common';
import { MerchantClassifierService } from './merchant-classifier.service';
import { MerchantClassifierController } from './merchant-classifier.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MerchantClassifierService],
  controllers: [MerchantClassifierController],
  exports: [MerchantClassifierService],
})
export class MerchantClassifierModule {}
