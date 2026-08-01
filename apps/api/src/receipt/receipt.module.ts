import { Module } from '@nestjs/common';
import { ReceiptService } from './receipt.service';
import { ReceiptController } from './receipt.controller';
import { MerchantClassifierModule } from '../merchant-classifier/merchant-classifier.module';

@Module({
  imports: [MerchantClassifierModule],
  controllers: [ReceiptController],
  providers: [ReceiptService],
  exports: [ReceiptService],
})
export class ReceiptModule {}
