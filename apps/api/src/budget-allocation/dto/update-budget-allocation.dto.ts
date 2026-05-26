import { PartialType } from '@nestjs/mapped-types';
import { CreateBudgetAllocationDto } from './create-budget-allocation.dto';

export class UpdateBudgetAllocationDto extends PartialType(CreateBudgetAllocationDto) {}
