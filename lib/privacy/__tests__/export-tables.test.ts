import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  EXPORT_TABLE_REGISTRY,
  EXPORT_LEGACY_TYPED_TABLES,
  EXPORT_EXCLUDED_TABLES,
  EXPORT_ROW_LIMIT,
  fetchOwnedRows,
} from '../export-tables';

describe('export-tables registry', () => {
  it('has no table name overlap between the registry, the legacy-typed set, and the excluded set', () => {
    const registryNames = EXPORT_TABLE_REGISTRY.map((s) => s.table);
    const legacyNames = [...EXPORT_LEGACY_TYPED_TABLES];
    const excludedNames = Object.keys(EXPORT_EXCLUDED_TABLES);

    const all = [...registryNames, ...legacyNames, ...excludedNames];
    expect(new Set(all).size).toBe(all.length);
  });

  it('never lists account_credentials or mfa_recovery_codes anywhere but the excluded set', () => {
    for (const table of ['account_credentials', 'mfa_recovery_codes']) {
      expect(EXPORT_TABLE_REGISTRY.some((s) => s.table === table)).toBe(false);
      expect(EXPORT_LEGACY_TYPED_TABLES.has(table)).toBe(false);
      expect(Object.keys(EXPORT_EXCLUDED_TABLES)).toContain(table);
      expect(EXPORT_EXCLUDED_TABLES[table].length).toBeGreaterThan(20);
    }
  });

  it('every excluded table has a real, non-empty written reason', () => {
    for (const [table, reason] of Object.entries(EXPORT_EXCLUDED_TABLES)) {
      expect(reason.length, `${table} needs a real reason`).toBeGreaterThan(20);
    }
  });

  it('every registry spec includes user_id in its own column list and has at least one orderBy column', () => {
    for (const spec of EXPORT_TABLE_REGISTRY) {
      expect(spec.columns).toContain('user_id');
      expect(spec.orderBy.length).toBeGreaterThan(0);
      // Every orderBy column must itself be a real selected column.
      for (const col of spec.orderBy) {
        expect(spec.columns).toContain(col);
      }
      // Every plainDateColumns entry must be a real selected column too.
      for (const col of spec.plainDateColumns) {
        expect(spec.columns).toContain(col);
      }
    }
  });

  it('registry table names are unique', () => {
    const names = EXPORT_TABLE_REGISTRY.map((s) => s.table);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('fetchOwnedRows', () => {
  const spec = EXPORT_TABLE_REGISTRY.find((s) => s.table === 'trades')!;

  it('casts only the plain-date columns, scopes by user_id, and orders/limits deterministically', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 't1' }] });
    const result = await fetchOwnedRows({ query } as never, 'user-1', spec);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('server_day::text as server_day');
    expect(sql).not.toContain('created_at::text');
    expect(sql).toContain('where user_id = $1');
    expect(sql).toContain('order by created_at desc nulls last');
    expect(sql).toContain('limit $2');
    expect(params).toEqual(['user-1', EXPORT_ROW_LIMIT + 1]);
    expect(result).toEqual({ rows: [{ id: 't1' }], truncated: false });
  });

  it('reports truncated=true and trims to EXPORT_ROW_LIMIT when the bound is hit', async () => {
    const overLimitRows = Array.from({ length: EXPORT_ROW_LIMIT + 1 }, (_, i) => ({ id: `t${i}` }));
    const query = vi.fn().mockResolvedValue({ rows: overLimitRows });
    const result = await fetchOwnedRows({ query } as never, 'user-1', spec);

    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(EXPORT_ROW_LIMIT);
  });

  it('never fabricates rows for a user with none', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const result = await fetchOwnedRows({ query } as never, 'user-1', spec);
    expect(result).toEqual({ rows: [], truncated: false });
  });
});
