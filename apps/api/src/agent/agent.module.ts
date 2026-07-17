import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TenantFinancialModule } from '../tenant-financial/tenant-financial.module';
import { ExpenseModule } from '../expense/expense.module';
import { ReceiptModule } from '../receipt/receipt.module';
import { CreditCardModule } from '../credit-card/credit-card.module';
import { BankAccountModule } from '../bank-account/bank-account.module';
import { MerchantClassifierModule } from '../merchant-classifier/merchant-classifier.module';
import { PriceCompareModule } from '../price-compare/price-compare.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentToolsService } from './tools/agent-tools.service';
import { OpenAiCompatibleProvider } from './llm/openai-compatible.provider';
import { FallbackLlmProvider } from './llm/fallback-llm.provider';
import { LLM_PROVIDER, type LlmProvider } from './llm/llm.types';
import { AgentChatThrottleGuard } from './agent-chat-throttle.guard';
import { AgentDailyQuotaGuard } from './agent-daily-quota.guard';

/**
 * Monta o provider de LLM: principal (AGENT_LLM_PROVIDER) com fallback automático
 * opcional (AGENT_LLM_FALLBACK). Cada um pode ter seu modelo
 * (AGENT_MODEL / AGENT_FALLBACK_MODEL). Se houver fallback, encadeia via
 * FallbackLlmProvider (cai para o próximo em caso de cota/sobrecarga).
 */
export function buildLlmProvider(): LlmProvider {
  const primaryId = (process.env['AGENT_LLM_PROVIDER'] || 'ollama').toLowerCase();
  const fallbackId = (process.env['AGENT_LLM_FALLBACK'] || '').toLowerCase();

  const primary = new OpenAiCompatibleProvider(primaryId, process.env['AGENT_MODEL'] || undefined);
  if (!fallbackId || fallbackId === primaryId) return primary;

  const fallback = new OpenAiCompatibleProvider(
    fallbackId,
    process.env['AGENT_FALLBACK_MODEL'] || undefined,
  );
  return new FallbackLlmProvider([primary, fallback]);
}

@Module({
  imports: [
    PrismaModule,
    TenantFinancialModule,
    ExpenseModule,
    ReceiptModule,
    CreditCardModule,
    BankAccountModule,
    MerchantClassifierModule,
    PriceCompareModule,
  ],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentToolsService,
    AgentChatThrottleGuard,
    AgentDailyQuotaGuard,
    { provide: LLM_PROVIDER, useFactory: buildLlmProvider },
  ],
})
export class AgentModule {}
