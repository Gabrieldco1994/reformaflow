import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CategoryBudgetController } from './category-budget.controller';
import { CategoryBudgetService } from './category-budget.service';

@Module({
  imports: [PrismaModule],
  controllers: [CategoryBudgetController],
  providers: [CategoryBudgetService],
})
export class CategoryBudgetModule {}
