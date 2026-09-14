import { describe, expect, it } from 'vitest';
import { renderWeekCloseSummary } from './format';

describe('renderWeekCloseSummary', () => {
  it('is honest when nothing was decided — never invented', () => {
    expect(renderWeekCloseSummary([])).toBe('Nothing changed.');
  });

  it('counts one accepted graduation as one rule added', () => {
    expect(renderWeekCloseSummary([{ kind: 'graduation', payload: { ruleId: 'x', ruleRendered: 'r' } }])).toBe(
      'One rule added.',
    );
  });

  it('pluralises multiple accepted graduations', () => {
    expect(
      renderWeekCloseSummary([
        { kind: 'graduation', payload: {} },
        { kind: 'graduation', payload: {} },
      ]),
    ).toBe('2 rules added.');
  });

  it('a recommitted relaxation reads as unchanged', () => {
    expect(renderWeekCloseSummary([{ kind: 'relaxation', payload: { resolution: 'recommit' } }])).toBe(
      'One rule unchanged.',
    );
  });

  it('an adjusted relaxation reads as changed', () => {
    expect(renderWeekCloseSummary([{ kind: 'relaxation', payload: { resolution: 'adjust' } }])).toBe(
      'One rule changed.',
    );
  });

  it('joins mixed outcomes into one line, capitalised once', () => {
    expect(
      renderWeekCloseSummary([
        { kind: 'graduation', payload: {} },
        { kind: 'relaxation', payload: { resolution: 'recommit' } },
      ]),
    ).toBe('One rule added. One rule unchanged.');
  });
});
