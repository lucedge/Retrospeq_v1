import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { escapeCsvCell, buildCsvSection, buildFullExportCsv } from '../export-csv';
import { EXPORT_TABLE_REGISTRY } from '../export-tables';
import type { ExportBundle } from '../export';

function emptyBundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    generatedAt: '2026-09-15T00:00:00.000Z',
    userId: 'user-1',
    profile: null,
    tradingAccounts: [],
    subscription: null,
    mfa: { recoveryCodesRemaining: 0, recoveryCodesIssued: 0 },
    tables: {},
    ...overrides,
  };
}

describe('escapeCsvCell', () => {
  it('passes plain values through unquoted', () => {
    expect(escapeCsvCell('EURUSD', false)).toBe('EURUSD');
    expect(escapeCsvCell(42, false)).toBe('42');
    expect(escapeCsvCell(null, false)).toBe('');
    expect(escapeCsvCell(undefined, false)).toBe('');
  });

  it('RFC 4180-quotes a comma, quote, or newline, doubling embedded quotes', () => {
    expect(escapeCsvCell('a,b', false)).toBe('"a,b"');
    expect(escapeCsvCell('a"b', false)).toBe('"a""b"');
    expect(escapeCsvCell('a\nb', false)).toBe('"a\nb"');
    expect(escapeCsvCell('a\rb', false)).toBe('"a\rb"');
  });

  it('JSON-stringifies object/array-valued (jsonb) cells rather than [object Object]', () => {
    expect(escapeCsvCell({ a: 1 }, false)).toBe('"{""a"":1}"');
    expect(escapeCsvCell(['x', 'y'], false)).toBe('"[""x"",""y""]"');
  });

  describe('formula-injection guard (only when guardFormulaInjection=true)', () => {
    it.each(['=cmd|calc', '+1+1', '-2+3', '@SUM(A1)', '\ttab'])(
      'prefixes %s with a single quote when guarded',
      (value) => {
        expect(escapeCsvCell(value, true)).toBe(`'${value}`);
      },
    );

    it('prefixes a leading-CR cell too, though it also then needs RFC 4180 quoting (CR is itself a quoting trigger)', () => {
      expect(escapeCsvCell('\rcr', true)).toBe('"\'\rcr"');
    });

    it('does NOT guard a plain negative number-shaped string (numeric columns are never guarded by callers, but the function itself must not corrupt one if ever passed)', () => {
      // The guard function itself does exactly what it's told; the real
      // safety net is `EXPORT_TABLE_REGISTRY`'s per-table
      // `freeTextColumns` never including a numeric column (see
      // export-tables.test.ts). Documented here as the reason why.
      expect(escapeCsvCell('-1.5000', false)).toBe('-1.5000');
    });

    it('leaves a safe string untouched even when guarded', () => {
      expect(escapeCsvCell('My Strategy', true)).toBe('My Strategy');
    });

    it('does not double-guard when the cell also needs RFC 4180 quoting', () => {
      expect(escapeCsvCell('=1+1,x', true)).toBe('"\'=1+1,x"');
    });
  });
});

describe('buildCsvSection', () => {
  it('emits a marker line, header row, one row per data row, and a trailing blank line', () => {
    const lines = buildCsvSection('widgets', ['id', 'name'], [{ id: '1', name: 'Foo' }]);
    expect(lines).toEqual(['## widgets (n=1)', 'id,name', '1,Foo', '']);
  });

  it('flags truncation in the marker line, never silently', () => {
    const lines = buildCsvSection('widgets', ['id'], [{ id: '1' }], [], true);
    expect(lines[0]).toContain('TRUNCATED');
  });

  it('applies the formula-injection guard only to the named freeTextColumns', () => {
    const lines = buildCsvSection(
      'strategies',
      ['id', 'name'],
      [{ id: '1', name: '=HYPERLINK("http://evil")' }],
      ['name'],
    );
    expect(lines[2]).toContain("'=HYPERLINK");
  });

  it('never guards a numeric-shaped id column even if the value starts with "-"', () => {
    const lines = buildCsvSection('trades', ['id', 'r_multiple'], [{ id: '1', r_multiple: '-1.5000' }], []);
    expect(lines[2]).toBe('1,-1.5000');
  });
});

describe('buildFullExportCsv', () => {
  it('includes a README section first', () => {
    const csv = buildFullExportCsv(emptyBundle());
    expect(csv.split('\n')[0]).toBe('## README');
  });

  it('includes every EXPORT_TABLE_REGISTRY table as its own section, even when empty', () => {
    const csv = buildFullExportCsv(emptyBundle());
    for (const spec of EXPORT_TABLE_REGISTRY) {
      expect(csv).toContain(`## ${spec.table} (n=0)`);
    }
  });

  it('never emits account_credentials or mfa_recovery_codes sections (registry omission enforces the denylist)', () => {
    const csv = buildFullExportCsv(emptyBundle());
    expect(csv).not.toContain('## account_credentials');
    expect(csv).not.toContain('## mfa_recovery_codes');
  });

  it('renders a real row for a registry table and flags truncation honestly', () => {
    const bundle = emptyBundle({
      tables: {
        trades: { rows: [{ id: 't1', user_id: 'u1', instrument: 'EURUSD' }], truncated: true },
      },
    });
    const csv = buildFullExportCsv(bundle);
    expect(csv).toContain('TRUNCATED');
    expect(csv).toContain('EURUSD');
  });

  it('guards a strategy name that looks like a formula, in the strategies table section', () => {
    const bundle = emptyBundle({
      tables: {
        strategies: {
          rows: [{ id: 's1', user_id: 'u1', name: '=cmd|"/c calc"!A1', current_version: 1, is_default: false, state: 'active', created_at: '2026-01-01T00:00:00.000Z' }],
          truncated: false,
        },
      },
    });
    const csv = buildFullExportCsv(bundle);
    expect(csv).toContain("'=cmd");
  });

  it('includes profile/tradingAccounts/subscription/mfa sections, honestly empty when null', () => {
    const csv = buildFullExportCsv(emptyBundle());
    expect(csv).toContain('## profile (n=0)');
    expect(csv).toContain('## tradingAccounts (n=0)');
    expect(csv).toContain('## subscription (n=0)');
    expect(csv).toContain('## mfa (n=1)'); // mfa is always a single object, never null
  });

  it('serializes a real jsonb column (e.g. fields.config) as JSON text, not [object Object]', () => {
    const bundle = emptyBundle({
      tables: {
        fields: {
          rows: [{ id: 'f1', user_id: 'u1', name: 'Setup', kind: 'account', data_type: 'note', origin: 'captured', owner_strategy_id: null, config: { options: ['a', 'b'] }, min_tier: 't0', state: 'active', created_at: '2026-01-01T00:00:00.000Z', archived_at: null }],
          truncated: false,
        },
      },
    });
    const csv = buildFullExportCsv(bundle);
    expect(csv).not.toContain('[object Object]');
    expect(csv).toContain('options');
  });
});
