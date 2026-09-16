import { describe, expect, it } from 'vitest';
import { attentionReason, formatLastSync } from '../format';

const NOW = new Date('2026-09-17T12:00:00.000Z');

describe('formatLastSync', () => {
  it('says "Never" for an account that has never synced, not "now"', () => {
    expect(formatLastSync(null, NOW)).toBe('Never');
  });

  it('renders minutes, hours and days from a real timestamp', () => {
    expect(formatLastSync('2026-09-17T11:46:00.000Z', NOW)).toBe('14 min ago');
    expect(formatLastSync('2026-09-17T09:00:00.000Z', NOW)).toBe('3 hr ago');
    expect(formatLastSync('2026-09-15T12:00:00.000Z', NOW)).toBe('2 days ago');
  });

  it('agrees in number with itself at the singular boundaries', () => {
    expect(formatLastSync('2026-09-17T11:00:00.000Z', NOW)).toBe('1 hr ago');
    expect(formatLastSync('2026-09-16T12:00:00.000Z', NOW)).toBe('1 day ago');
  });

  it('clamps a future timestamp to the present rather than reading "in 3 minutes"', () => {
    expect(formatLastSync('2026-09-17T12:03:00.000Z', NOW)).toBe('just now');
  });

  it('degrades honestly on an unparseable timestamp', () => {
    expect(formatLastSync('not-a-date', NOW)).toBe('Unknown');
  });
});

describe('attentionReason', () => {
  it('names the real cause when the sync worker recorded a known code', () => {
    expect(attentionReason('CREDENTIAL_REJECTED')).toContain('rejected the saved credential');
  });

  it('never invents a cause for an absent or unknown code', () => {
    const unknown = attentionReason(null);
    expect(unknown).toContain('didn’t tell us why');
    expect(attentionReason('SOME_FUTURE_CODE')).toBe(unknown);
  });
});
