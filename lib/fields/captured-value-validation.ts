import type { FieldDataType } from './strategy-validation';

/**
 * Module 06 (Review & Graduation) Slice 1, story 1.3 — the close-out
 * screen's late-fill path is the FIRST write path into `trade_captures`
 * anywhere in this repo that accepts a trader-chosen VALUE for a real
 * field-registry field (every prior write — `lockPreEntryCaptures`,
 * `writeTradeCaptureAction`'s trim-reason chip row — either trusts an
 * already-validated upstream source or writes a literal, hardcoded field
 * id with its own fixed option set). There is therefore no existing
 * "does this captured VALUE actually match this field's own data_type/
 * config" validator anywhere to reuse — `lib/fields/field-validation.ts`'s
 * `validateFieldConfig` validates a proposed field's own CONFIG SHAPE at
 * creation time (e.g. "does `options[]` look like a real option list"),
 * a genuinely different question from "is this specific captured value a
 * legal member of that shape" (e.g. "is `value` actually one of those
 * options"). Pure and DB-free, mirroring `field-validation.ts`'s own
 * separation — no `server-only` import, importable from a future client
 * component too.
 */

export class CapturedValueInvalidError extends Error {
  readonly code = 'CAPTURED_VALUE_INVALID' as const;
  constructor(
    readonly dataType: FieldDataType,
    readonly reason: string,
  ) {
    super(`Invalid captured value for data_type "${dataType}": ${reason}`);
    this.name = 'CapturedValueInvalidError';
  }
}

export interface CapturedValueFieldConfig {
  options?: string[];
  min?: number;
  max?: number;
}

/**
 * Validates a single captured VALUE against the field's own `data_type`/
 * `config` — never trusts the shape a client claims to be sending.
 *
 * Deliberately scoped to the four data types `strategy-validation.ts`'s
 * own `PRE_ENTRY_SAFE_TYPES` allows at `capture_moment = 'pre_entry'`
 * (`pick_one`, `pick_many`, `bool`, `rating`) — `number`/`note` both
 * require a keyboard (AGENTS.md's fast-capture rule: "nothing on a
 * fast-capture screen takes a keyboard"), so Module 03's own authoring
 * pipeline already refuses to let either be assigned `capture_moment:
 * 'pre_entry'` on a strategy version in the first place. A caller of this
 * function (`writeLateCaptureAction`) only ever reaches it after
 * confirming the field IS a `pre_entry` field on the trade's own bound
 * strategy version snapshot — reaching `number`/`note` here would mean
 * that upstream invariant was already violated, so both fail loudly
 * rather than silently accepting an untyped value, matching this file's
 * own "never trust the shape" posture applied to itself.
 */
export function validateCapturedValue(
  dataType: FieldDataType,
  config: CapturedValueFieldConfig,
  value: unknown,
): void {
  switch (dataType) {
    case 'pick_one': {
      const options = config.options ?? [];
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new CapturedValueInvalidError(dataType, 'value must be one of this field\'s own options.');
      }
      return;
    }
    case 'pick_many': {
      const options = config.options ?? [];
      if (!Array.isArray(value) || value.length === 0) {
        throw new CapturedValueInvalidError(dataType, 'value must be a non-empty array of this field\'s own options.');
      }
      if (!value.every((v): v is string => typeof v === 'string' && options.includes(v))) {
        throw new CapturedValueInvalidError(dataType, 'every entry must be one of this field\'s own options.');
      }
      if (new Set(value).size !== value.length) {
        throw new CapturedValueInvalidError(dataType, 'entries must be distinct.');
      }
      return;
    }
    case 'bool': {
      if (typeof value !== 'boolean') {
        throw new CapturedValueInvalidError(dataType, 'value must be a boolean.');
      }
      return;
    }
    case 'rating': {
      // §4.3's own default when a rating field's config omits min/max
      // (`field-validation.ts`'s `validateFieldConfig`, "min, max
      // (default 1-5)") — mirrored here for the same reason
      // `createField` fills the same default in at write time.
      const min = config.min ?? 1;
      const max = config.max ?? 5;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new CapturedValueInvalidError(dataType, `value must be a whole number between ${min} and ${max}.`);
      }
      return;
    }
    case 'number':
    case 'note':
      throw new CapturedValueInvalidError(
        dataType,
        `data_type "${dataType}" cannot be captured at a fast-capture surface (requires a keyboard) — this should be structurally impossible to reach.`,
      );
    default: {
      const exhaustive: never = dataType;
      throw new CapturedValueInvalidError(exhaustive as FieldDataType, `unrecognised data_type "${String(exhaustive)}".`);
    }
  }
}
