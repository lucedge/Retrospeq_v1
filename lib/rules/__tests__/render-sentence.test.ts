import { describe, expect, it } from 'vitest';
import { RenderSentenceError, renderSentence } from '../render-sentence';

describe('renderSentence — Module 04 §3.1/§5.1, dispatch item 1', () => {
  it('renders a number/lte sentence with the {value} placeholder substituted', () => {
    expect(renderSentence('risk_pct', 'lte', 1.5)).toBe('Never risk more than 1.5% per trade.');
  });

  it('renders a duration/gte sentence', () => {
    expect(renderSentence('time_since_last_loss', 'gte', 15)).toBe(
      'Wait at least 15 minutes after a loss before entering again.',
    );
  });

  it('renders a pick_many/in sentence, joining the array as a readable list', () => {
    expect(renderSentence('day_of_week', 'in', ['mon', 'wed', 'fri'])).toBe('Only trade on mon, wed, fri.');
  });

  it('renders a pick_many/not_in sentence', () => {
    expect(renderSentence('day_of_week', 'not_in', ['sat', 'sun'])).toBe('Never trade on sat, sun.');
  });

  it('renders a clock_time/between sentence using {value[0]}/{value[1]}', () => {
    expect(renderSentence('entry_clock_time', 'between', ['09:30', '16:00'])).toBe('Only trade between 09:30 and 16:00.');
  });

  it('renders a bool is_true sentence with no placeholder, ignoring the stored value', () => {
    expect(renderSentence('stop_set_at_entry', 'is_true', true)).toBe('Always set a stop before entering.');
  });

  it('renders a bool is_false sentence', () => {
    expect(renderSentence('stop_moved_against', 'is_false', false)).toBe('Never move your stop against the position.');
  });

  it('formats an integer-valued number without a spurious decimal', () => {
    expect(renderSentence('consecutive_losses', 'lte', 3)).toBe('Stop trading after 3 losses in a row.');
  });

  it('formats a numeric string value the same as a number, stripping trailing zeros', () => {
    expect(renderSentence('risk_pct', 'lte', '2.0')).toBe('Never risk more than 2% per trade.');
  });

  describe('errors', () => {
    it('throws RenderSentenceError(UNKNOWN_OPERAND) for an unknown operand_id', () => {
      expect(() => renderSentence('not_a_real_operand', 'lte', 1)).toThrow(RenderSentenceError);
      try {
        renderSentence('not_a_real_operand', 'lte', 1);
        expect.unreachable();
      } catch (err) {
        expect((err as RenderSentenceError).code).toBe('UNKNOWN_OPERAND');
      }
    });

    it('throws RenderSentenceError(NO_PHRASING_FOR_OPERATOR) when the operand has no template for this operator', () => {
      // risk_pct's own phrasing map only declares `lte` (lib/rules/operand-catalogue.ts).
      expect(() => renderSentence('risk_pct', 'gte', 1)).toThrow(RenderSentenceError);
      try {
        renderSentence('risk_pct', 'gte', 1);
        expect.unreachable();
      } catch (err) {
        expect((err as RenderSentenceError).code).toBe('NO_PHRASING_FOR_OPERATOR');
      }
    });

    it('throws RenderSentenceError(INVALID_VALUE_SHAPE) when a "between" operator gets a non-2-element value', () => {
      expect(() => renderSentence('entry_clock_time', 'between', ['09:30'])).toThrow(RenderSentenceError);
    });

    it('throws RenderSentenceError(INVALID_VALUE_SHAPE) for a non-finite numeric value', () => {
      expect(() => renderSentence('risk_pct', 'lte', 'not-a-number')).toThrow(RenderSentenceError);
    });

    it('throws RenderSentenceError(INVALID_VALUE_SHAPE) for a non-string clock_time part', () => {
      expect(() => renderSentence('entry_clock_time', 'between', [930, '16:00'])).toThrow(RenderSentenceError);
    });
  });

  describe('formatPart edge cases', () => {
    it('formats a single (non-array) pick value via the bare {value} path as a plain string', () => {
      // renderSentence itself does not enforce array-ness for pick_many
      // (that is validate-operand-op-value.ts's job, run earlier in the
      // real authoring pipeline) — this proves the fallback branch.
      expect(renderSentence('day_of_week', 'in', 'mon')).toBe('Only trade on mon.');
    });
  });
});
