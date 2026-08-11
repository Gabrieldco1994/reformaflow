import { IsString, IsNumber, IsDateString, IsIn, IsOptional, IsBoolean, Matches, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExpenseType, LaborCategory, ExpenseStatus } from '@reformaflow/domain';

export class CreateExpenseDto {
  @ApiProperty({ enum: Object.values(ExpenseType) })
  @IsString()
  @IsIn(Object.values(ExpenseType))
  tipoDespesa!: string;

  @ApiPropertyOptional({ enum: Object.values(LaborCategory) })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(LaborCategory))
  categoriaMaoDeObra?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiProperty({ example: 150.50, description: 'Valor unitário em reais' })
  @IsNumber()
  @Min(0.01)
  valor!: number;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(1)
  quantidade!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  titulo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fornecedor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  link?: string;

  @ApiPropertyOptional({ description: 'URL direta da imagem do produto (override manual)' })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty({ enum: ['A_VISTA', 'PARCELADO', 'QUINZENAL', 'PIX', 'PAGAMENTO_CONTA'] })
  @IsString()
  @IsIn(['A_VISTA', 'PARCELADO', 'QUINZENAL', 'PIX', 'PAGAMENTO_CONTA'])
  formaPagamento!: string;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  dataPagamento?: string;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  quantidadeParcela?: number;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  dataInicioParcela?: string;

  @ApiPropertyOptional({ example: '2026-05-01', description: 'Data real da compra (competência). Independe do vencimento/parcela. Vazio = usa a data de pagamento/início.' })
  @IsOptional()
  @IsDateString()
  dataCompra?: string | null;

  /** Carimbo de série recorrente — preenchido só pelo fluxo de recorrência. */
  @ApiPropertyOptional({ description: 'Chave da série recorrente (uso interno)' })
  @IsOptional()
  @IsString()
  recurrenceKey?: string | null;

  @ApiProperty({ enum: Object.values(ExpenseStatus) })
  @IsString()
  @IsIn(Object.values(ExpenseStatus))
  status!: string;

  @ApiPropertyOptional({ description: 'Despesa fixa mensal (ocorrência virtual, não gera linhas)' })
  @IsOptional()
  @IsBoolean()
  recorrente?: boolean;

  @ApiPropertyOptional({ example: '2026-12-01', description: 'Último mês da recorrência (null = sem fim)' })
  @IsOptional()
  @IsDateString()
  recorrenciaFim?: string | null;

  // ─── Vínculos manuais (opcionais) ────────────────────────────
  // Quando informados, o backend popula automaticamente cardLast4/bankLast4
  // a partir do CreditCard/BankAccount referenciado.

  @ApiPropertyOptional({ description: 'Vincula despesa a um cartão de crédito (qualquer projeto do tenant)' })
  @IsOptional()
  @IsString()
  creditCardId?: string;

  @ApiPropertyOptional({ description: 'Vincula despesa a uma conta bancária (qualquer projeto do tenant)' })
  @IsOptional()
  @IsString()
  bankAccountId?: string;

  @ApiPropertyOptional({ description: 'Vincula a uma despesa de outro projeto (cross-project, evita dupla contagem)' })
  @IsOptional()
  @IsString()
  linkedExpenseId?: string;

  // ─── "Cartão paga cartão" (opcional) ────────────────────────
  // Quando esta cobrança quita a fatura de OUTRO cartão (ex.: paguei o Nubank
  // com o Itaú, com juros), os dois campos abaixo viram
  // `Expense.settlesInvoiceKey = "{last4-do-cartão-quitado}:{dueMonth}"`.
  // Ver docs/visao-conta-faturas.md §4.

  @ApiPropertyOptional({ description: 'Cartão CUJA FATURA esta cobrança quita (não é o cartão onde ela apareceu)' })
  @IsOptional()
  @IsString()
  settlesInvoiceCardId?: string;

  @ApiPropertyOptional({ example: '2026-08', description: 'Mês de vencimento da fatura quitada (YYYY-MM)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'settlesInvoiceDueMonth deve estar no formato YYYY-MM' })
  settlesInvoiceDueMonth?: string;
}
