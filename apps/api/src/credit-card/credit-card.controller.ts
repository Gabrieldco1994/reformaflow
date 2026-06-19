import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query,
  UploadedFiles, UseInterceptors, BadRequestException,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { CreditCardService } from './credit-card.service';
import {
  CreateCreditCardDto,
  ImportStatementQueryDto,
  LinkToExpenseDto,
  UpdateCreditCardDto,
} from './dto/credit-card.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { PdfPasswordRequiredError, PdfWrongPasswordError, ImageOcrError } from './parsers';

@RequireModule('creditCards')
@UseInterceptors(TenantInterceptor)
@Controller('projects/:projectId/credit-cards')
export class CreditCardController {
  constructor(private readonly service: CreditCardService) {}

  @Get()
  list(@CurrentTenant() tenantId: string, @Param('projectId') projectId: string) {
    return this.service.listCards(tenantId, projectId);
  }

  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Body() dto: CreateCreditCardDto,
  ) {
    return this.service.createCard(tenantId, projectId, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCreditCardDto,
  ) {
    return this.service.updateCard(tenantId, projectId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.deleteCard(tenantId, projectId, id);
  }

  @Get(':id/imports')
  imports(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') cardId: string,
  ) {
    return this.service.listImports(tenantId, projectId, cardId);
  }

  @Get(':id/suggest-links')
  suggestLinks(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') cardId: string,
  ) {
    return this.service.suggestLinks(tenantId, projectId, cardId);
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

  @Post(':id/import-statement')
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 10 * 1024 * 1024, files: 5 } }))
  async importStatement(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') cardId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Query() query: ImportStatementQueryDto,
    @Body() body: { decisions?: string } | undefined,
  ) {
    const list = (files ?? []).slice(0, 5);
    if (list.length === 0) {
      return { error: 'arquivo ausente' };
    }
    const buffers = list.map((f) => f.buffer);
    const fileName = list[0].originalname;
    const source = (query.source ?? 'AUTO') as any;
    // decisions vêm via multipart field 'decisions' como JSON-string
    let decisions: import('./credit-card.service').ImportDecision[] | undefined;
    if (body?.decisions) {
      try {
        const parsed = JSON.parse(body.decisions);
        if (Array.isArray(parsed)) decisions = parsed;
      } catch {
        throw new BadRequestException({ message: 'campo "decisions" deve ser JSON array' });
      }
    }
    try {
      // Passa os Buffers puros para o service (parser PDF/imagem precisa de binário)
      if ((query.mode ?? 'preview') === 'commit') {
        return await this.service.commitImport(
          tenantId,
          projectId,
          cardId,
          buffers,
          fileName,
          source,
          query.periodLabel,
          query.password,
          decisions,
        );
      }
      return await this.service.previewImport(
        tenantId,
        projectId,
        cardId,
        buffers,
        fileName,
        source,
        query.password,
      );
    } catch (err) {
      if (err instanceof PdfPasswordRequiredError) {
        throw new BadRequestException({
          code: 'pdf_password_required',
          message: 'PDF protegido por senha. Informe a senha para continuar.',
        });
      }
      if (err instanceof PdfWrongPasswordError) {
        throw new BadRequestException({
          code: 'pdf_wrong_password',
          message: 'Senha do PDF incorreta.',
        });
      }
      if (err instanceof ImageOcrError) {
        throw new BadRequestException({ code: 'image_ocr_failed', message: err.message });
      }
      throw err;
    }
  }
}
