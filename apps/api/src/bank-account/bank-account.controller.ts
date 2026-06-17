import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query,
  UploadedFile, UseInterceptors, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { BankAccountService } from './bank-account.service';
import {
  CreateBankAccountDto,
  ImportBankStatementQueryDto,
  LinkToExpenseDto,
  LinkToReceiptDto,
  UpdateBankAccountDto,
} from './dto/bank-account.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { PdfPasswordRequiredError, PdfWrongPasswordError } from './parsers';

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

  @Get(':id/suggest-links')
  suggestLinks(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
  ) {
    return this.service.suggestLinks(tenantId, projectId, accountId);
  }

  @Get(':id/suggest-receipt-links')
  suggestReceiptLinks(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
  ) {
    return this.service.suggestReceiptLinks(tenantId, projectId, accountId);
  }

  @Post('transactions/:expenseId/link')
  linkToExpense(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('expenseId') expenseId: string,
    @Body() body: LinkToExpenseDto,
  ) {
    return this.service.linkToExpense(tenantId, projectId, expenseId, body.targetExpenseId, {
      parcelaIndex: body.parcelaIndex,
      realValor: body.realValor,
    });
  }

  @Delete('transactions/:expenseId/link')
  unlink(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('expenseId') expenseId: string,
  ) {
    return this.service.unlinkExpense(tenantId, projectId, expenseId);
  }

  @Post('receipts/:receiptId/link')
  linkToReceipt(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('receiptId') receiptId: string,
    @Body() body: LinkToReceiptDto,
  ) {
    return this.service.linkToReceipt(tenantId, projectId, receiptId, body.targetReceiptId);
  }

  @Delete('receipts/:receiptId/link')
  unlinkReceiptEndpoint(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('receiptId') receiptId: string,
  ) {
    return this.service.unlinkReceipt(tenantId, projectId, receiptId);
  }

  @Post(':id/import-statement')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async importStatement(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') accountId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() query: ImportBankStatementQueryDto,
    @Body() body: { decisions?: string } | undefined,
  ) {
    if (!file) return { error: 'arquivo ausente' };
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
          tenantId, projectId, accountId, file.buffer, file.originalname, source,
          query.periodLabel, query.password, decisions,
        );
      }
      return await this.service.previewImport(
        tenantId, projectId, accountId, file.buffer, file.originalname, source, query.password,
      );
    } catch (err) {
      if (err instanceof PdfPasswordRequiredError) {
        throw new BadRequestException({ code: 'pdf_password_required', message: 'PDF protegido por senha.' });
      }
      if (err instanceof PdfWrongPasswordError) {
        throw new BadRequestException({ code: 'pdf_wrong_password', message: 'Senha do PDF incorreta.' });
      }
      throw err;
    }
  }
}
