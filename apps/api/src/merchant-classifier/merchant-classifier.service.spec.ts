import { ExpenseType } from '@reformaflow/domain';
import { MERCHANT_CATEGORIES, MERCHANT_TO_EXPENSE_TYPE } from './merchant-classifier.service';

describe('MERCHANT_TO_EXPENSE_TYPE export', () => {
  it('mapeia toda MERCHANT_CATEGORIES para um ExpenseType válido', () => {
    for (const cat of MERCHANT_CATEGORIES) {
      expect(MERCHANT_TO_EXPENSE_TYPE[cat]).toBeDefined();
      expect(Object.values(ExpenseType)).toContain(MERCHANT_TO_EXPENSE_TYPE[cat]);
    }
  });
});
