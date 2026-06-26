import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TenantFinancialModule } from '../tenant-financial/tenant-financial.module';
import { ExpenseModule } from '../expense/expense.module';
import { ReceiptModule } from '../receipt/receipt.module';
import { CreditCardModule } from '../credit-card/credit-card.module';
import { BankAccountModule } from '../bank-account/bank-account.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentToolsService } from './tools/agent-tools.service';
import { OpenAiCompatibleProvider } from './llm/openai-compatible.provider';
import { LLM_PROVIDER } from './llm/llm.types';

@Module({
  imports: [
    PrismaModule,
    TenantFinancialModule,
    ExpenseModule,
    ReceiptModule,
    CreditCardModule,
    BankAccountModule,
  ],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentToolsService,
    { provide: LLM_PROVIDER, useClass: OpenAiCompatibleProvider },
  ],
})
export class AgentModule {}
