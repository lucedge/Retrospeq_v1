'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ManagedFieldEntry } from '@/lib/fields/fields-repository';
import type { FieldUsageDependent } from '@/lib/fields/fields-repository';
import { renameFieldAction, archiveFieldAction, promoteFieldAction, type FieldStrategyOption } from './actions';

/**
 * Module 03 (Field Registry & Strategy) §4.5/§6.1 — the fields management
 * screen. Lists every field a trader owns, grouped by kind (§1.1: "Derived
 * fields never appear in any picker" — read here as "never appear as an
 * ACTIONABLE row either," they are shown for context only, matching
 * §5.2's own reference markup's `.chips--static`, no `<input>` at all),
 * with rename/archive/promote wired to the real backend
 * (`app/(app)/fields/actions.ts`).
 *
 * Same "Server Component composes the read, Client Component owns the
 * interaction" split every other list+lifecycle-action screen in this repo
 * already uses (`RuleList.tsx`, `StrategyBuilder.tsx`) — `page.tsx` fetches
 * once; this component owns every row's own busy/error/renaming/
 * confirming-archive state independently, matching `RuleList.tsx`'s own
 * `RowState` shape and `patchRow` convention closely (deliberately, not
 * coincidentally — this is the closest existing precedent for "list
 * existing items, inline promote/demote/archive-style lifecycle actions,"
 * per this slice's own dispatch instruction to match it).
 *
 * DESIGN-SYSTEM / SPEC-FIDELITY CHOICES:
 *
 * - Derived fields render as `.rq-tag--muted` chips with zero controls —
 *   the exact same translation `StrategyBuilder.tsx`'s own "Recorded
 *   automatically" group already established for §5.2's `.chips--static`.
 * - "Add a field" (`/fields/new`) is the one page-level primary `.rq-btn`;
 *   every per-row action (Rename/Archive/Share across strategies) is
 *   `.rq-btn--ghost` — identical reasoning to `RuleList.tsx`'s own header
 *   ("a row-level utility action in a list is the same device
 *   `JoinControl.tsx`/`SplitControl.tsx`... already use"). An open row's
 *   own inline "Save"/"Yes, archive" IS a real primary `.rq-btn`/
 *   `.rq-btn--equal` pair while that row is expanded — the same
 *   acknowledged, non-blocking "only one row's chooser is ever open at a
 *   time in normal use" exception `RuleList.tsx`'s own header documents for
 *   its hard-cap swap chooser and `EditRuleControl.tsx`'s own Save button,
 *   reused here rather than re-litigated.
 * - Archive gets a genuine `.rq-btn--equal` confirm pair ("Yes, archive" /
 *   "Keep it"), not a bare click-to-archive — §4.5's own archive row has no
 *   documented un-archive path, the same "deliberate, low-frequency,
 *   IRREVERSIBLE action" class `RuleList.tsx`'s own retire-confirm
 *   reasoning already covers, reused here for the identical reason (this is
 *   about a genuinely irreversible-in-practice product action, not the
 *   §5.9 "never blocks a live trade action" rule, which governs proceeding
 *   past a risk breach mid-trade, not this).
 * - Promote ("Share across strategies," §4.5's own "Promote strategy_var ->
 *   account" row) is a plain ghost button with no confirm step — promotion
 *   is additive and safe ("same field id, all history intact"), so there is
 *   nothing here for a confirm step to protect against, unlike archive.
 * - `FIELD_IN_USE`'s blocking payload (§9, §5.2's own "Deletion blocked by
 *   dependency" reference markup) renders the named dependents inline in
 *   the row rather than a separate modal/route — this repo has no modal
 *   primitive in play anywhere in this module (`RuleList.tsx`'s own
 *   `alertdialog` sections are likewise inline, not a portal/overlay), so
 *   this matches that established shape rather than inventing a new one.
 */

function dataTypeLabel(dataType: ManagedFieldEntry['dataType']): string {
  switch (dataType) {
    case 'pick_one':
      return 'Pick one';
    case 'pick_many':
      return 'Pick many';
    case 'number':
      return 'Number';
    case 'bool':
      return 'Yes / No';
    case 'rating':
      return 'Rating';
    case 'note':
      return 'Note';
  }
}

interface RowState {
  field: ManagedFieldEntry;
  busy: boolean;
  error: string | null;
  dependents: FieldUsageDependent[] | null;
  renaming: boolean;
  renameValue: string;
  confirmingArchive: boolean;
}

function initialRowState(field: ManagedFieldEntry): RowState {
  return {
    field,
    busy: false,
    error: null,
    dependents: null,
    renaming: false,
    renameValue: field.name,
    confirmingArchive: false,
  };
}

const UNEXPECTED_ERROR_MESSAGE = 'Something unexpected went wrong. Please try again.';

export function FieldsList({
  initialFields,
  strategies,
  entitled,
}: {
  initialFields: ManagedFieldEntry[];
  strategies: FieldStrategyOption[];
  /** Whether the caller's plan permits creating a NEW custom field
   *  (`fields.custom`, docs/adr/0019) — gates only the "Add a field" link
   *  below, never the ability to see/rename/archive/promote fields the
   *  trader already has (a downgraded-from-Pro trader keeps read/lifecycle
   *  access to existing rows, matching §7.3's own "Downgrade to free makes
   *  strategies read-only without data loss" framing for the sibling
   *  strategy module — existing custom fields are not hidden or force-
   *  archived just because the plan changed). `page.tsx` renders its own
   *  separate Pro upsell block when this is `false`, so this component
   *  must NOT also render its own "Add a field" primary button in that
   *  case — doing so would put two primary `.rq-btn`s in one view. */
  entitled: boolean;
}) {
  const [rows, setRows] = useState<RowState[]>(() => initialFields.filter((f) => f.kind !== 'derived').map(initialRowState));
  const derivedFields = initialFields.filter((f) => f.kind === 'derived');

  function strategyName(ownerStrategyId: string | null): string | null {
    if (!ownerStrategyId) return null;
    return strategies.find((s) => s.strategyId === ownerStrategyId)?.name ?? null;
  }

  function patchRow(fieldId: string, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r) => (r.field.fieldId === fieldId ? { ...r, ...patch } : r)));
  }

  function patchField(fieldId: string, rowPatch: Partial<RowState>, fieldPatch: Partial<ManagedFieldEntry>) {
    setRows((prev) =>
      prev.map((r) => (r.field.fieldId === fieldId ? { ...r, ...rowPatch, field: { ...r.field, ...fieldPatch } } : r)),
    );
  }

  function startRename(fieldId: string) {
    patchRow(fieldId, { renaming: true, confirmingArchive: false, error: null, dependents: null });
  }

  function cancelRename(fieldId: string, originalName: string) {
    patchRow(fieldId, { renaming: false, renameValue: originalName, error: null });
  }

  async function saveRename(fieldId: string) {
    const row = rows.find((r) => r.field.fieldId === fieldId);
    if (!row) return;
    const name = row.renameValue.trim();
    if (name.length === 0) {
      patchRow(fieldId, { error: 'Give this field a name.' });
      return;
    }
    patchRow(fieldId, { busy: true, error: null });
    try {
      const result = await renameFieldAction(fieldId, name);
      if (result.success) {
        patchField(fieldId, { busy: false, renaming: false, error: null }, { name: result.name ?? name });
        return;
      }
      patchRow(fieldId, { busy: false, error: result.error?.user_message ?? 'Something went wrong. Please try again.' });
    } catch {
      patchRow(fieldId, { busy: false, error: UNEXPECTED_ERROR_MESSAGE });
    }
  }

  function startArchive(fieldId: string) {
    patchRow(fieldId, { confirmingArchive: true, renaming: false, error: null, dependents: null });
  }

  function cancelArchive(fieldId: string) {
    patchRow(fieldId, { confirmingArchive: false });
  }

  async function confirmArchive(fieldId: string) {
    patchRow(fieldId, { busy: true, error: null, dependents: null });
    try {
      const result = await archiveFieldAction(fieldId);
      if (result.success) {
        patchField(
          fieldId,
          { busy: false, confirmingArchive: false, error: null },
          { state: 'archived', archivedAt: result.archivedAt ?? new Date().toISOString() },
        );
        return;
      }
      patchRow(fieldId, {
        busy: false,
        confirmingArchive: false,
        error: result.error?.user_message ?? 'Something went wrong. Please try again.',
        dependents: result.dependents ?? null,
      });
    } catch {
      patchRow(fieldId, { busy: false, confirmingArchive: false, error: UNEXPECTED_ERROR_MESSAGE });
    }
  }

  async function handlePromote(fieldId: string) {
    patchRow(fieldId, { busy: true, error: null });
    try {
      const result = await promoteFieldAction(fieldId);
      if (result.success) {
        patchField(fieldId, { busy: false, error: null }, { kind: 'account', ownerStrategyId: null });
        return;
      }
      patchRow(fieldId, { busy: false, error: result.error?.user_message ?? 'Something went wrong. Please try again.' });
    } catch {
      patchRow(fieldId, { busy: false, error: UNEXPECTED_ERROR_MESSAGE });
    }
  }

  const activeRows = rows.filter((r) => r.field.state === 'active');
  const archivedRows = rows.filter((r) => r.field.state === 'archived');

  // One `.rq-btn` per view: the pinned "Add a field" stands down while a
  // row has its own rename or archive-confirm open, each of which brings
  // its own decisive control. Same enforcement `/rules` uses.
  const anyRowExpanded = rows.some((r) => r.renaming || r.confirmingArchive);

  return (
    // Frame 3.18 (`brand/docs/screens/rulebook.html#3.18`): derived
    // fields as static chips first, the trader's own beneath, the CTA
    // pinned. `.field-group`/`.chips--static`/`.field-list` all shipped
    // in the 2026-09-14 design program and are wired here for the first
    // time.
    <div className="flex flex-1 flex-col gap-5">
      {derivedFields.length > 0 && (
        <section className="field-group" aria-labelledby="derived-h">
          <h3 id="derived-h">Recorded automatically</h3>
          <p className="rq-sub">You never fill these in. They still appear in your results.</p>
          <ul className="chips chips--static">
            {derivedFields.map((f) => (
              <li key={f.fieldId} className="chip chip--muted">
                {f.name}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="field-group" aria-labelledby="custom-h">
        <h3 id="custom-h">Your fields</h3>

        {activeRows.length === 0 && (
          <p className="rq-sub">
            {entitled
              ? "You haven't added any fields of your own yet."
              : "You don't have any custom fields — your derived fields above are recorded automatically regardless of plan."}
          </p>
        )}

        {activeRows.length > 0 && (
          <ul className="flex flex-col gap-3">
            {activeRows.map((row) => (
              <FieldRow
                key={row.field.fieldId}
                row={row}
                strategyName={strategyName(row.field.ownerStrategyId)}
                onRenameStart={() => startRename(row.field.fieldId)}
                onRenameCancel={() => cancelRename(row.field.fieldId, row.field.name)}
                onRenameChange={(v) => patchRow(row.field.fieldId, { renameValue: v })}
                onRenameSave={() => saveRename(row.field.fieldId)}
                onArchiveClick={() => startArchive(row.field.fieldId)}
                onArchiveCancel={() => cancelArchive(row.field.fieldId)}
                onArchiveConfirm={() => confirmArchive(row.field.fieldId)}
                onPromote={() => handlePromote(row.field.fieldId)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Frame 3.18 renders an archived field in place, greyed, with an
          "archived" chip. Kept behind the same `<details class="retired">`
          disclosure `/rules` uses for retired rules — a trader with a long
          history should not have to scroll past their own dead fields to
          reach the live ones, and the disclosure is the device this design
          system already has for "not your current concern, not hidden". */}
      {archivedRows.length > 0 && (
        <details className="retired">
          <summary>
            Archived fields (<span className="rq-num">{archivedRows.length}</span>)
          </summary>
          <ul className="field-list pt-1">
            {archivedRows.map((row) => (
              <li key={row.field.fieldId} className="field-list__item">
                <span className="field-list__name text-ink-faint">
                  {row.field.name} <span className="chip chip--small">archived</span>
                </span>
                <span className="field-list__usage">
                  {dataTypeLabel(row.field.dataType)}
                  {row.field.kind === 'strategy_var' && strategyName(row.field.ownerStrategyId)
                    ? ` · ${strategyName(row.field.ownerStrategyId)}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Frame 3.18's bottom-pinned CTA. Only ONE of this and page.tsx's
          own `.gate` "See Pro" ever renders — see this component's own
          `entitled` prop doc comment. */}
      {entitled && !anyRowExpanded && (
        <div className="push pt-2">
          <Link href="/fields/new" className="rq-btn rq-btn--block">
            Add a field
          </Link>
        </div>
      )}
    </div>
  );
}

function FieldRow({
  row,
  strategyName,
  onRenameStart,
  onRenameCancel,
  onRenameChange,
  onRenameSave,
  onArchiveClick,
  onArchiveCancel,
  onArchiveConfirm,
  onPromote,
}: {
  row: RowState;
  strategyName: string | null;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameChange: (v: string) => void;
  onRenameSave: () => void;
  onArchiveClick: () => void;
  onArchiveCancel: () => void;
  onArchiveConfirm: () => void;
  onPromote: () => void;
}) {
  const { field } = row;

  return (
    <li data-testid={`field-row-${field.fieldId}`}>
      <section className="rq-card flex flex-col gap-3" aria-label={field.name}>
        {/* Frame 3.18's `.field-list__item` lane: the name (with its type
            as a small chip) on the left, what depends on it on the right.
            The right-hand lane shows SCOPE, not the frame's "2 rules · 3
            strategies" usage count — no list read computes a usage tally
            (`ManagedFieldEntry` has no such field, and `field_usages` is
            only queried on an archive attempt), so a count here would be
            invented. See this batch's ledger entry; inventory row 3.18
            names the gap. */}
        <div className="field-list__item !border-0 !py-0">
          {row.renaming ? (
            <input
              value={row.renameValue}
              maxLength={40}
              autoComplete="off"
              aria-label={`Rename ${field.name}`}
              className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
              onChange={(e) => onRenameChange(e.target.value)}
            />
          ) : (
            <span className="field-list__name">
              {field.name} <span className="chip chip--small">{dataTypeLabel(field.dataType)}</span>
            </span>
          )}
          {/* One lane, one fact. This used to say "This strategy only"
              here AND "Only in Breakout." on its own line below — the
              same thing twice, the second time more usefully. Named
              strategy wins; "Shared" is the honest label for an
              account-wide field. */}
          <span className="field-list__usage">
            {field.kind === 'account' ? 'Shared' : (strategyName ?? 'This strategy only')}
          </span>
        </div>

        {row.error && (
          <p className="rq-sub" role="alert">
            {row.error}
          </p>
        )}

        {/* Frame 3.20's blocked-deletion shape (`.alert--blocking` +
            `.dependents`), reused here because it is the same fact: this
            field cannot go away while something depends on it. */}
        {row.dependents && row.dependents.length > 0 && (
          <div className="alert alert--blocking" role="alertdialog" aria-label={`${field.name} is used elsewhere`}>
            <p>Used by:</p>
            <ul className="dependents">
              {row.dependents.map((d) => (
                <li key={`${d.usedBy}-${d.usedById}`}>{d.label}</li>
              ))}
            </ul>
          </div>
        )}

        {row.confirmingArchive ? (
          <div className="rq-well flex flex-col gap-2">
            <p className="rq-sub">
              Archiving stops this field from being offered anywhere. Captured history stays exactly as it is. This
              can&apos;t be undone.
            </p>
            <div className="rq-btn-row">
              <button type="button" className="rq-btn rq-btn--equal" disabled={row.busy} onClick={onArchiveConfirm}>
                {row.busy ? 'Archiving…' : 'Yes, archive'}
              </button>
              <button type="button" className="rq-btn rq-btn--equal" disabled={row.busy} onClick={onArchiveCancel}>
                Keep it
              </button>
            </div>
          </div>
        ) : row.renaming ? (
          <div className="flex gap-2">
            <button
              type="button"
              className="rq-btn rq-btn--ghost flex-1"
              disabled={row.busy}
              onClick={onRenameCancel}
            >
              Cancel
            </button>
            <button type="button" className="rq-btn flex-1" disabled={row.busy} onClick={onRenameSave}>
              {row.busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          /* `.link`s, not ghost buttons — the same call `/rules` makes for
             per-row lifecycle controls in a list that can show many rows
             (frame 3.3's `.rule__actions`). */
          <div className="rule__actions">
            <button type="button" className="link" disabled={row.busy} onClick={onRenameStart}>
              Rename
            </button>
            {field.kind === 'strategy_var' && (
              <button type="button" className="link" disabled={row.busy} onClick={onPromote}>
                {row.busy ? 'Sharing…' : 'Share across strategies'}
              </button>
            )}
            <button type="button" className="link" disabled={row.busy} onClick={onArchiveClick}>
              Archive
            </button>
          </div>
        )}
      </section>
    </li>
  );
}
