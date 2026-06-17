import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConciliacaoModule } from '../conciliacao/conciliacao.module';
import { CreditCardController } from './credit-card.controller';
import { CreditCardTenantController } from './credit-card-tenant.controller';
import { CreditCardService } from './credit-card.service';

@Module({
  imports: [PrismaModule, ConciliacaoModule],
  controllers: [CreditCardController, CreditCardTenantController],
  providers: [CreditCardService],
})
export class CreditCardModule {}
