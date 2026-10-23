import { ImportExpenseCategory, ImportExpenseStatus } from '@prisma/client';

export interface ListImportExpensesQuery {
  page?: number;
  limit?: number;
  category?: ImportExpenseCategory;
  status?: ImportExpenseStatus;
}
