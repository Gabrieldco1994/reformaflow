import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query,
  UploadedFile, UseInterceptors, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { PdfPasswordRequiredError, PdfWrongPasswordError } from './parsers';

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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async importStatement(
    @CurrentTenant() tenantId: string,
    @Param('projectId') projectId: string,
    @Param('id') cardId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() query: ImportStatementQueryDto,
    @Body() body: { decisions?: string } | undefined,
  ) {
    if (!file) {
      return { error: 'arquivo ausente' };
    }
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
      // Passa o Buffer puro para o service (parser PDF precisa de binário)
      if ((query.mode ?? 'preview') === 'commit') {
        return await this.service.commitImport(
          tenantId,
          projectId,
          cardId,
          file.buffer,
          file.originalname,
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
        file.buffer,
        file.originalname,
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
      throw err;
    }
  }
}
