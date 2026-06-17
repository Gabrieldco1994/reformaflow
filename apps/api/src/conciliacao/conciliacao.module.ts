import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConciliacaoService } from './conciliacao.service';

@Module({
  imports: [PrismaModule],
  providers: [ConciliacaoService],
  exports: [ConciliacaoService],
})
export class ConciliacaoModule {}
