import 'server-only';
import type { ExportBundle } from './export';
import { EXPORT_TABLE_REGISTRY, EXPORT_ROW_LIMIT } from './export-tables';

/**
 * Module 01 story 5.1's CSV half of "JSON + CSV bundle ... of all
 * user-owned rows" (00-foundation §5.4) — fixing the QA FAIL on
 * 589807c: the JSON side (`export.ts`/`export-tables.ts`) was made
 * genuinely complete, but the CSV file the privacy page
 * (`app/(app)/privacy/page.tsx:232`) and the export-ready email
 * template both promise ("trades, fills, rules, evaluations, strategies,
 * fields ... as JSON and CSV") stayed frozen at trading-accounts-only
 * (the old `tradingAccountsToCsv`, since deleted — unguarded and unused).
 *
 * DELIVERY SHAPE DECISION (2026-09-15, logged per this fix's own
 * dispatch): the export bucket delivers exactly two signed URLs
 * (`ExportArtifactManifest.jsonUrl`/`csvUrl`, `export-job.ts`) and this
 * repo has no zip/archive dependency (`package.json` checked — none
 * present). Adding one for this alone would be the "heavy dependency"
 * the dispatch says not to add without logging the tradeoff; hand-
 * rolling a ZIP writer would be new, unaudited binary-format code for a
 * data-rights-critical path. Emitting one Storage object + one signed
 * URL per table (~40 links) would also be a `/privacy` UI regression no
 * dispatch asked for. Instead: keep the ONE `csvUrl` file, structured as
 * a documented multi-section CSV — a `## <name> (n=<count>[, TRUNCATED])`
 * marker line precedes each table's own header row and data rows, a
 * blank line separates sections, and a leading `## README` section
 * explains the shape inside the file itself (no out-of-band docs
 * required to read it). This is the narrowest option already supported
 * by the existing delivery path; a real per-table ZIP is the natural
 * upgrade once a zip dependency is deliberately, separately added.
 */

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  // jsonb columns come back from `pg` already parsed into a JS
  // object/array (no override in `pg-type-parsers.ts` for json/jsonb,
  // unlike timestamp/timestamptz) — stringify explicitly, per this
  // fix's own dispatch ("jsonb columns serialized as JSON strings").
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const NEEDS_QUOTING = /["\r\n,]/;
/**
 * OWASP CSV-formula-injection guard, applied to EVERY cell by default: a
 * cell whose first character would make Excel/Sheets evaluate it as a
 * formula gets a leading `'`. The only exemption is a plain number
 * (`-1.5000`, `1e-3`), where a leading `-`/`+` is a legitimate sign.
 * Guard-by-default replaced a per-column allowlist of "free text" columns
 * that missed user-typed `instrument` and `trade_captures.value` option
 * labels (security review, 2d96c17) — a new column can't fail open.
 */
const FORMULA_INJECTION_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function escapeCsvCell(value: unknown): string {
  let text = cellToText(value);
  if (FORMULA_INJECTION_LEAD.test(text) && !PLAIN_NUMBER.test(text)) {
    text = `'${text}`;
  }
  if (NEEDS_QUOTING.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvLine(cells: readonly string[]): string {
  return cells.join(',');
}

/** One `## <name>` section: marker line, header row, one row per data
 *  row (each cell escaped/guarded per-column), trailing blank line. */
export function buildCsvSection(
  name: string,
  header: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  truncated = false,
): string[] {
  const marker = truncated
    ? `## ${name} (n=${rows.length}, TRUNCATED — only the first ${EXPORT_ROW_LIMIT} rows are included; request a fresh export for anything newer)`
    : `## ${name} (n=${rows.length})`;
  // Quoted like any cell: the truncated marker contains commas.
  const lines = [csvLine([escapeCsvCell(marker)]), csvLine(header)];
  for (const row of rows) {
    lines.push(csvLine(header.map((col) => escapeCsvCell(row[col]))));
  }
  lines.push('');
  return lines;
}

const PROFILE_HEADER = ['displayName', 'locale', 'timezone', 'telemetryOptOut', 'onboardingStage', 'createdAt'] as const;
const TRADING_ACCOUNT_HEADER = [
  'id', 'label', 'platform', 'accountKind', 'baseCurrency', 'dayRollover', 'syncTier',
  'status', 'connectedAt', 'disconnectedAt', 'createdAt',
] as const;
const SUBSCRIPTION_HEADER = ['plan', 'status', 'currentPeriodEnd'] as const;
const MFA_HEADER = ['recoveryCodesRemaining', 'recoveryCodesIssued'] as const;

const README = [
  'This file is a multi-table CSV export of every data table Retrospeq holds for this account.',
  'Each section below begins with a "## <name>" marker line naming the table and its row count;',
  `TRUNCATED marks a table capped at ${EXPORT_ROW_LIMIT} rows. Column names are the underlying`,
  'field names. Object/array-valued columns (config, payload, metadata, triggers, etc.) are',
  'included as their raw JSON text inside one cell. The same data, fully structured and never',
  'flattened, is also available via the separate JSON download link.',
].join(' ');

/**
 * Builds the full multi-table CSV bundle described above. Iterates
 * `EXPORT_TABLE_REGISTRY` directly (never a hand-maintained parallel
 * list) so a table added there can't silently stay CSV-less the way
 * `tradingAccountsToCsv` did before this fix.
 */
export function buildFullExportCsv(bundle: ExportBundle): string {
  const lines: string[] = ['## README', csvLine([escapeCsvCell(README)]), ''];

  lines.push(
    ...buildCsvSection(
      'profile',
      PROFILE_HEADER,
      bundle.profile ? [bundle.profile as unknown as Record<string, unknown>] : [],
    ),
  );
  lines.push(
    ...buildCsvSection(
      'tradingAccounts',
      TRADING_ACCOUNT_HEADER,
      bundle.tradingAccounts as unknown as Array<Record<string, unknown>>,
    ),
  );
  lines.push(
    ...buildCsvSection(
      'subscription',
      SUBSCRIPTION_HEADER,
      bundle.subscription ? [bundle.subscription as unknown as Record<string, unknown>] : [],
    ),
  );
  lines.push(
    ...buildCsvSection('mfa', MFA_HEADER, [bundle.mfa as unknown as Record<string, unknown>]),
  );

  for (const spec of EXPORT_TABLE_REGISTRY) {
    const result = bundle.tables[spec.table];
    lines.push(
      ...buildCsvSection(
        spec.table,
        spec.columns,
        result?.rows ?? [],
        result?.truncated ?? false,
      ),
    );
  }

  return lines.join('\n');
}
