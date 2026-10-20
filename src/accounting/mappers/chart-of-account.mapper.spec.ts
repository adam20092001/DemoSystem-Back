import { AccountStatus, AccountType } from '@prisma/client';
import { SafeChartAccount } from '../types/safe-chart-account';
import { buildAccountTree } from './chart-of-account.mapper';

function makeAccount(
  overrides: Partial<SafeChartAccount> = {},
): SafeChartAccount {
  return {
    id: 'id',
    code: 'CODE',
    name: 'Name',
    type: AccountType.ASSET,
    systemKey: null,
    parentId: null,
    level: 1,
    isPostable: true,
    status: AccountStatus.ACTIVE,
    normalBalance: 'DEBIT',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('buildAccountTree', () => {
  it('anida correctamente padre -> hijo -> nieto', () => {
    const rows = [
      makeAccount({ id: 'root', code: '1', parentId: null }),
      makeAccount({ id: 'child', code: '10', parentId: 'root' }),
      makeAccount({ id: 'grandchild', code: '101', parentId: 'child' }),
    ];

    const tree = buildAccountTree(rows);

    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('root');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe('child');
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].id).toBe('grandchild');
  });

  it('varias raíces independientes', () => {
    const rows = [
      makeAccount({ id: 'a', code: '1' }),
      makeAccount({ id: 'b', code: '2' }),
    ];
    const tree = buildAccountTree(rows);
    expect(tree).toHaveLength(2);
  });

  it('ordena por code en cada nivel', () => {
    const rows = [
      makeAccount({ id: 'z', code: 'Z' }),
      makeAccount({ id: 'a', code: 'A' }),
    ];
    const tree = buildAccountTree(rows);
    expect(tree.map((n) => n.id)).toEqual(['a', 'z']);
  });

  it('un parentId que no está en el conjunto cargado se trata como raíz, nunca se pierde', () => {
    const rows = [makeAccount({ id: 'orphan', parentId: 'ghost-parent' })];
    const tree = buildAccountTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('orphan');
  });

  it('lista vacía -> árbol vacío', () => {
    expect(buildAccountTree([])).toEqual([]);
  });
});
