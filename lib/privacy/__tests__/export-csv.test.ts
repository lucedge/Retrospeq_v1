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
    expect(escapeCsvCell('EURUSD')).toBe('EURUSD');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('RFC 4180-quotes a comma, quote, or newline, doubling embedded quotes', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"');
    expect(escapeCsvCell('a\rb')).toBe('"a\rb"');
  });

  it('JSON-stringifies object/array-valued (jsonb) cells rather than [object Object]', () => {
    expect(escapeCsvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(escapeCsvCell(['x', 'y'])).toBe('"[""x"",""y""]"');
  });

  describe('formula-injection guard (every cell, by default)', () => {
    it.each(['=cmd|calc', '+1+1', '-2+3', '@SUM(A1)', '\ttab'])(
      'prefixes %s with a single quote when guarded',
      (value) => {
        expect(escapeCsvCell(value)).toBe(`'${value}`);
      },
    );

    it('prefixes a leading-CR cell too, though it also then needs RFC 4180 quoting (CR is itself a quoting trigger)', () => {
      expect(escapeCsvCell('\rcr')).toBe('"\'\rcr"');
    });

    it.each(['-1.5000', '+2', '1e-3', '-0.25', '42'])('does not guard the plain number %s', (value) => {
      expect(escapeCsvCell(value)).toBe(value);
    });

    it('guards a jsonb scalar string (pg returns it as a plain JS string)', () => {
      expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    });

    it('leaves a safe string untouched even when guarded', () => {
      expect(escapeCsvCell('My Strategy')).toBe('My Strategy');
    });

    it('does not double-guard when the cell also needs RFC 4180 quoting', () => {
      expect(escapeCsvCell('=1+1,x')).toBe('"\'=1+1,x"');
    });
  });
});

describe('buildCsvSection', () => {
  it('emits a marker line, header row, one row per data row, and a trailing blank line', () => {
    const lines = buildCsvSection('widgets', ['id', 'name'], [{ id: '1', name: 'Foo' }]);
    expect(lines).toEqual(['## widgets (n=1)', 'id,name', '1,Foo', '']);
  });

  it('flags truncation in the marker line, never silently', () => {
    const lines = buildCsvSection('widgets', ['id'], [{ id: '1' }], true);
    expect(lines[0]).toContain('TRUNCATED');
  });

  it('guards user-typed columns no allowlist named (instrument, capture option labels) — security regression 2d96c17', () => {
    const lines = buildCsvSection(
      'trade_captures',
      ['id', 'instrument', 'value', 'r_multiple'],
      [{ id: '1', instrument: '=HYPERLINK("http://evil")', value: '@SUM(A1)', r_multiple: '-1.5000' }],
    );
    expect(lines[2]).toBe(`1,"'=HYPERLINK(""http://evil"")",'@SUM(A1),-1.5000`);
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

describe('README and section markers are single quoted cells', () => {
  it('keeps the README and a truncated marker in one spreadsheet column despite commas', () => {
    const [marker] = buildCsvSection('trades', ['id'], [{ id: 'a' }], true);
    expect(marker.startsWith('"## trades (n=1, TRUNCATED')).toBe(true);
    const csv = buildFullExportCsv(emptyBundle());
    const readmeLine = csv.split(/\r?\n/)[1];
    expect(readmeLine.startsWith('"This file is')).toBe(true);
    expect(readmeLine).not.toContain('Module 01');
  });
});
