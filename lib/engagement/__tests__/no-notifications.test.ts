import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Module 07 §5.6, verbatim: "This module sends no notifications at all
 * ... Module 06 sends exactly one notification per weekly review, and
 * that is the product's entire outbound volume." AGENTS.md: "One
 * notification per week, total."
 *
 * A cheap, static, no-DB-needed guardrail (Module 06 §4.10 step 6's own
 * dispatch note): if any future change under `lib/engagement/` ever
 * imports the email provider (or literally calls a Resend/notification
 * API), this test fails the build before it ships, rather than relying
 * on a human reviewer noticing a new import in a large diff.
 */

const ENGAGEMENT_DIR = join(__dirname, '..');
const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+['"]@\/lib\/privacy\/email-provider['"]/,
  /getTransactionalEmailProvider/,
  /api\.resend\.com/i,
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue; // this test file itself, and any of its siblings
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('lib/engagement/ — Module 07 §5.6 "this module sends no notifications at all"', () => {
  it('no file under lib/engagement/ imports or references the transactional email provider', () => {
    const files = collectTsFiles(ENGAGEMENT_DIR);
    expect(files.length).toBeGreaterThan(0); // sanity: the scan itself actually found files

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (FORBIDDEN_IMPORT_PATTERNS.some((re) => re.test(content))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
