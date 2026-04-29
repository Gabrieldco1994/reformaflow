import { BudgetStatus } from '@reformaflow/domain';

export interface DashboardData {
  totalPlanned: number;
  totalActual: number;
  totalBalance: number;
  percentConsumed: number;
  status: BudgetStatus | '-';
  byRoom: RoomSummary[];
}

export interface RoomSummary {
  roomName: string;
  planned: number;
  actual: number;
  balance: number;
  percentConsumed: number;
  status: BudgetStatus | '-';
}
