import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query,
  UploadedFiles, UseInterceptors, BadRequestException,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { BankAccountService } from './bank-account.service';
import {
  CreateBankAccountDto,
  ImportBankStatementQueryDto,
  LinkToExpenseDto,
  LinkToReceiptDto,
  UpdateBankAccountDto,
} from './dto/bank-account.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentTenant, CurrentUser } from '../common/decorators/tenant.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { PdfPasswordRequiredError, PdfWrongPasswordError, ImageOcrError } from './parsers';
import {
  assertRateioRequester,
  RateioRequester,
} from '../expense/rateio.types';

@RequireModule('bankAccounts')
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/bank-accounts')
export class BankAccountController {
  constructor(private readonly service: BankAccountService) {}

  @Get()
  list(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.listAccounts(tenantId, projectId);
  }

  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateBankAccountDto,
  ) {
    return this.service.createAccount(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateBankAccountDto,
  ) {
    return this.service.updateAccount(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.deleteAccount(tenantId, projectId, id);
  }

  @Get(':id/imports')
  imports(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
  ) {
    return this.service.listImports(tenantId, projectId, accountId);
  }

  @Get(':id/imports/:importId')
  importDetail(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
    @Param('importId') importId: string,
  ) {
    return this.service.getImportDetail(tenantId, projectId, accountId, importId);
  }

  @Delete(':id/imports/:importId')
  undoImport(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
    @Param('importId') importId: string,
    @CurrentUser() requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    return this.service.undoImport(tenantId, projectId, accountId, importId, requester);
  }

  @Get(':id/suggest-links')
  suggestLinks(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
    @CurrentUser() requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    return this.service.suggestLinks(tenantId, projectId, accountId, requester);
  }

  @Get(':id/suggest-receipt-links')
  suggestReceiptLinks(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
    @CurrentUser() requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    return this.service.suggestReceiptLinks(
      tenantId,
      projectId,
      accountId,
      requester,
    );
  }

  @Post('transactions/:expenseId/link')
  linkToExpense(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('expenseId') expenseId: string,
    @Body() body: LinkToExpenseDto,
    @CurrentUser() requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    return this.service.linkToExpense(
      tenantId,
      projectId,
      expenseId,
      body.targetExpenseId,
      {
        parcelaIndex: body.parcelaIndex,
        realValor: body.realValor,
      },
      requester,
    );
  }

  @Delete('transactions/:expenseId/link')
  unlink(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('expenseId') expenseId: string,
    @CurrentUser() requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    return this.service.unlinkExpense(tenantId, projectId, expenseId, requester);
  }

  @Post('receipts/:receiptId/link')
  linkToReceipt(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('receiptId') receiptId: string,
    @Body() body: LinkToReceiptDto,
    @CurrentUser() requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    return this.service.linkToReceipt(
      tenantId,
      projectId,
      receiptId,
      body.targetReceiptId,
      requester,
    );
  }

  @Delete('receipts/:receiptId/link')
  unlinkReceiptEndpoint(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('receiptId') receiptId: string,
    @CurrentUser() requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    return this.service.unlinkReceipt(tenantId, projectId, receiptId, requester);
  }

  @Post(':id/import-statement')
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 10 * 1024 * 1024, files: 5 } }))
  async importStatement(
    @CurrentTenant() tenantId: string,
    @CurrentUser() requester: RateioRequester & { id: string },
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Query() query: ImportBankStatementQueryDto,
    @Body() body: { decisions?: string } | undefined,
  ) {
    assertRateioRequester(requester);
    const list = (files ?? []).slice(0, 5);
    if (list.length === 0) return { error: 'arquivo ausente' };
    const buffers = list.map((f) => f.buffer);
    const fileName = list[0].originalname;
    const source = (query.source ?? 'AUTO') as 'AUTO' | 'OFX' | 'CSV_GENERIC' | 'PDF';
    let decisions: import('./bank-account.service').BankImportDecision[] | undefined;
    if (body?.decisions) {
      try {
        const parsed = JSON.parse(body.decisions);
        if (Array.isArray(parsed)) decisions = parsed;
      } catch {
        throw new BadRequestException({ message: 'campo "decisions" deve ser JSON array' });
      }
    }
    try {
      if ((query.mode ?? 'preview') === 'commit') {
        return await this.service.commitImport(
          tenantId, projectId, accountId, buffers, fileName, source,
          query.periodLabel, query.password, decisions, requester.id, requester,
        );
      }
      return await this.service.previewImport(
        tenantId, projectId, accountId, buffers, fileName, source, query.password, requester,
      );
    } catch (err) {
      if (err instanceof PdfPasswordRequiredError) {
        throw new BadRequestException({ code: 'pdf_password_required', message: 'PDF protegido por senha.' });
      }
      if (err instanceof PdfWrongPasswordError) {
        throw new BadRequestException({ code: 'pdf_wrong_password', message: 'Senha do PDF incorreta.' });
      }
      if (err instanceof ImageOcrError) {
        throw new BadRequestException({ code: 'image_ocr_failed', message: err.message });
      }
      throw err;
    }
  }
}
