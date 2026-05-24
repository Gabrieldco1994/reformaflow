import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query,
  UploadedFile, UseInterceptors, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CreditCardService } from './credit-card.service';
import {
  CreateCreditCardDto,
  ImportStatementQueryDto,
  UpdateCreditCardDto,
} from './dto/credit-card.dto';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentTenant } from '../common/decorators/tenant.decorator';
import { PdfPasswordRequiredError, PdfWrongPasswordError } from './parsers';

@RequireModule('creditCards')
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
    @Body() body: { targetExpenseId: string },
  ) {
    return this.service.linkToExpense(tenantId, projectId, expenseId, body.targetExpenseId);
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
  ) {
    if (!file) {
      return { error: 'arquivo ausente' };
    }
    const source = (query.source ?? 'AUTO') as any;
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
