import { SafeChartAccount } from './safe-chart-account';

/** Nodo del árbol jerárquico devuelto por GET /chart-of-accounts/tree. */
export interface AccountTreeNode extends SafeChartAccount {
  children: AccountTreeNode[];
}
