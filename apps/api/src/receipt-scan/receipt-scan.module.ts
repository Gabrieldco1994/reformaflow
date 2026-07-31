import { Module } from '@nestjs/common';
import { ReceiptScanController } from './receipt-scan.controller';

/**
 * Leitura de comprovante por foto. Sem provider: o parser é função pura que
 * fala com a IA — não há estado nem dependência de banco, porque este módulo
 * NÃO grava nada (ver `receipt-scan.controller.ts`).
 */
@Module({
  controllers: [ReceiptScanController],
})
export class ReceiptScanModule {}
