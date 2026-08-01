import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UploadedFiles,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  ReceiptService,
  type ReceiptImportCommitResult,
  type ReceiptImportError,
  type ReceiptImportPreviewResult,
} from './receipt.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { UpdateReceiptDto } from './dto/update-receipt.dto';
import {
  ImportReceiptBodyDto,
  ImportReceiptQueryDto,
  RECEIPT_IMPORT_MODE_COMMIT,
  RECEIPT_IMPORT_MODE_PREVIEW,
  parseReceiptImportDecisions,
} from './dto/import-receipt.dto';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import {
  CurrentTenant,
  CurrentUser,
} from '../common/decorators/tenant.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import {
  PdfPasswordRequiredError as BankPdfPasswordRequiredError,
  PdfWrongPasswordError as BankPdfWrongPasswordError,
  ImageOcrError,
} from '../bank-account/parsers';
import {
  PdfPasswordRequiredError as CardPdfPasswordRequiredError,
  PdfWrongPasswordError as CardPdfWrongPasswordError,
} from '../credit-card/parsers';

const RECEIPT_IMPORT_FILE_FIELD = 'files';
const RECEIPT_IMPORT_MAX_FILES = 5;
const RECEIPT_IMPORT_MAX_FILE_SIZE = 10 * 1024 * 1024;

@ApiTags('receipts')
@ApiBearerAuth()
@UseInterceptors(TenantInterceptor)
@RequireModule('receipts')
@Controller('projects/:projectId/receipts')
export class ReceiptController {
  constructor(private readonly service: ReceiptService) {}

  @Post()
  @ApiOperation({ summary: 'Criar recebimento' })
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateReceiptDto,
  ) {
    return this.service.create(tenantId, projectId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar recebimentos do projeto' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.service.findAllByProject(tenantId, projectId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualizar recebimento' })
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateReceiptDto,
  ) {
    return this.service.update(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remover recebimento (soft delete)' })
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(tenantId, projectId, id);
  }

  @Post('import')
  @ApiOperation({
    summary:
      'Importar extrato/fatura sem conta ou cartão vinculado (pseudo-origem Carteira)',
  })
  @UseInterceptors(
    FilesInterceptor(RECEIPT_IMPORT_FILE_FIELD, RECEIPT_IMPORT_MAX_FILES, {
      limits: { fileSize: RECEIPT_IMPORT_MAX_FILE_SIZE },
    }),
  )
  async importReceipts(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: { id: string },
    @Param('projectId') projectId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Query() query: ImportReceiptQueryDto,
    @Body() body: ImportReceiptBodyDto = {},
  ): Promise<
    ReceiptImportPreviewResult | ReceiptImportCommitResult | ReceiptImportError
  > {
    const list = files ?? [];
    if (
      list.length === 0 ||
      list.length > RECEIPT_IMPORT_MAX_FILES ||
      list.some(
        (file) =>
          Math.max(file.size ?? 0, file.buffer.length) >
          RECEIPT_IMPORT_MAX_FILE_SIZE,
      )
    ) {
      throw new BadRequestException('arquivo ausente ou fora dos limites');
    }

    const buffers = list.map((f) => f.buffer);
    const firstFileName = list[0]?.originalname;
    const decisions = parseReceiptImportDecisions(body.decisions);

    try {
      if (
        (query.mode ?? RECEIPT_IMPORT_MODE_PREVIEW) ===
        RECEIPT_IMPORT_MODE_COMMIT
      ) {
        return await this.service.commitImport(
          tenantId,
          projectId,
          buffers,
          query.documentType,
          query.source,
          query.periodLabel,
          query.password,
          decisions,
          requester.id,
          firstFileName,
        );
      }
      return await this.service.previewImport(
        tenantId,
        projectId,
        buffers,
        query.documentType,
        query.source,
        query.periodLabel,
        query.password,
        firstFileName,
      );
    } catch (err) {
      if (
        err instanceof BankPdfPasswordRequiredError ||
        err instanceof CardPdfPasswordRequiredError
      ) {
        throw new BadRequestException({
          code: 'pdf_password_required',
          message: 'PDF protegido por senha.',
        });
      }
      if (
        err instanceof BankPdfWrongPasswordError ||
        err instanceof CardPdfWrongPasswordError
      ) {
        throw new BadRequestException({
          code: 'pdf_wrong_password',
          message: 'Senha do PDF incorreta.',
        });
      }
      if (err instanceof ImageOcrError) {
        throw new BadRequestException({
          code: 'image_ocr_failed',
          message: err.message,
        });
      }
      throw err;
    }
  }

  @Post(':id/link-account')
  @ApiOperation({
    summary: 'Vincular recebimento a uma conta bancária retroativamente',
  })
  linkAccount(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { accountId: string },
  ) {
    return this.service.linkAccount(tenantId, projectId, id, body.accountId);
  }
}
