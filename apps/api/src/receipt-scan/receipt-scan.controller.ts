import {
  BadRequestException,
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { ImageOcrError, isImageBuffer, detectImageMime } from '../credit-card/parsers/image-ocr';
import { scanReceiptImage, type ReceiptScanResult } from './receipt-scan.parser';

/**
 * Leitura de UM comprovante por foto (cupom, print de PIX, recibo).
 *
 * NÃO grava nada: devolve os campos lidos para o usuário confirmar no modal —
 * mesmo contrato do fluxo de voz, que também interpreta e deixa a decisão de
 * salvar com quem lançou. Gravar direto a partir de OCR seria dinheiro entrando
 * no consolidado sem ninguém ter conferido o valor.
 *
 * Distinto de `credit-cards/:id/import-statement` e `bank-accounts/:id/
 * import-statement`, que leem fatura/extrato (N lançamentos) e exigem uma
 * origem. Aqui não há cartão nem conta: a despesa resultante nasce na Carteira.
 *
 * Gated por `expenses` (não `receipts`): o que sai daqui é uma DESPESA, e é o
 * módulo de despesas que o usuário precisa ter para lançá-la.
 */
@ApiTags('expenses')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@RequireModule('expenses')
@Controller('projects/:projectId/expenses')
export class ReceiptScanController {
  @Post('scan-receipt')
  @ApiOperation({ summary: 'Ler uma despesa a partir da foto de um comprovante' })
  // 1 arquivo, 10 MB: é um comprovante só — o limite maior das rotas de
  // fatura/extrato (5 arquivos) não faz sentido aqui.
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  async scanReceipt(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<ReceiptScanResult> {
    const file = (files ?? [])[0];
    if (!file) {
      throw new BadRequestException({ message: 'Envie uma foto do comprovante.' });
    }

    // Valida pelo CONTEÚDO (magic bytes), não pelo `mimetype` do multipart —
    // esse header vem do cliente e pode mentir. `detectImageMime` já é a fonte
    // usada pelas rotas de import por imagem.
    if (!isImageBuffer(file.buffer)) {
      throw new BadRequestException({
        message: 'O arquivo enviado não é uma imagem. Envie uma foto ou print do comprovante.',
      });
    }
    const mimeType = detectImageMime(file.buffer);
    if (!mimeType) {
      throw new BadRequestException({
        message: 'Formato de imagem não suportado. Use JPG, PNG ou WEBP.',
      });
    }

    try {
      return await scanReceiptImage(file.buffer, mimeType);
    } catch (err) {
      // `ImageOcrError` já carrega mensagem escrita para o usuário final
      // (chave ausente, timeout, IA fora do ar). Deixar escapar viraria 500 puro.
      if (err instanceof ImageOcrError) {
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }
  }
}
