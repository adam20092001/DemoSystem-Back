import { AgingBucket } from '../accounts-payable-calculator';
import { AccountsPayableFilterQuery } from './accounts-payable-filter.query';

export interface ListAccountsPayableQuery extends AccountsPayableFilterQuery {
  page?: number;
  limit?: number;
  agingBucket?: AgingBucket;
}
