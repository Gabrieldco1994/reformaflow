import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PendenciaController } from './pendencia.controller';
import { PendenciaService } from './pendencia.service';

@Module({
  imports: [PrismaModule],
  controllers: [PendenciaController],
  providers: [PendenciaService],
})
export class PendenciaModule {}
