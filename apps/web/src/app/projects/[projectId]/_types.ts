import type { NavModule } from '@reformaflow/domain';

export interface ProjectInfo {
  id: string;
  name: string;
  type: string;
  description?: string;
}

export type { NavModule };
