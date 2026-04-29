import { Module } from '@nestjs/common';
import { MaterialPurchaseService } from './material-purchase.service';
import { MaterialPurchaseController } from './material-purchase.controller';

@Module({
  controllers: [MaterialPurchaseController],
  providers: [MaterialPurchaseService],
  exports: [MaterialPurchaseService],
})
export class MaterialPurchaseModule {}
