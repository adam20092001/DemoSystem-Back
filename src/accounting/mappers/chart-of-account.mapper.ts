import { Prisma } from '@prisma/client';
import { accountNormalBalance } from '../account-hierarchy.utils';
import { AccountTreeNode } from '../types/account-tree-node';
import { SafeChartAccount } from '../types/safe-chart-account';

/** Select explícito del plan de cuentas jerárquico completo (A1.2). */
export const CHART_ACCOUNT_SAFE_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  systemKey: true,
  parentId: true,
  level: true,
  isPostable: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AccountSelect;

export type ChartAccountSafeRow = Prisma.AccountGetPayload<{
  select: typeof CHART_ACCOUNT_SAFE_SELECT;
}>;

export function toSafeChartAccount(row: ChartAccountSafeRow): SafeChartAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    systemKey: row.systemKey,
    parentId: row.parentId,
    level: row.level,
    isPostable: row.isPostable,
    status: row.status,
    normalBalance: accountNormalBalance(row.type),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Construye el árbol completo a partir de una lista PLANA ya cargada en
 * memoria (una sola consulta, sin N+1): un plan de cuentas, incluso un
 * PCGE completo, es como máximo unos pocos miles de filas — trivial de
 * mantener en memoria, mismo criterio de "sin sobreingeniería" que el
 * resto del dominio (nunca una consulta recursiva en SQL para esto).
 * Devuelve solo las raíces (parentId null); cada nodo lleva sus propios
 * `children` ya anidados. Si un parentId apunta a un id que no está en el
 * conjunto cargado (no debería pasar nunca, por la FK), ese nodo se trata
 * como raíz en vez de perderse en silencio.
 */
export function buildAccountTree(rows: SafeChartAccount[]): AccountTreeNode[] {
  const nodesById = new Map<string, AccountTreeNode>();
  for (const row of rows) {
    nodesById.set(row.id, { ...row, children: [] });
  }

  const roots: AccountTreeNode[] = [];
  for (const row of rows) {
    const node = nodesById.get(row.id)!;
    const parent =
      row.parentId !== null ? nodesById.get(row.parentId) : undefined;
    if (parent !== undefined) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortByCode = (a: AccountTreeNode, b: AccountTreeNode): number =>
    a.code.localeCompare(b.code);
  const sortRecursive = (nodes: AccountTreeNode[]): void => {
    nodes.sort(sortByCode);
    for (const node of nodes) {
      sortRecursive(node.children);
    }
  };
  sortRecursive(roots);

  return roots;
}
