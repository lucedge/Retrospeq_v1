import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keeps the developer documentation honest about the things a script can
 * check: counts, links, and coverage. It deliberately does NOT try to
 * check whether an explanation is still *true* — that is what review is
 * for.
 *
 * This exists because the previous developer guide drifted exactly here:
 * it claimed 33 migrations when there were 35, 43 ADRs when there were
 * 46, and described a Supabase arrangement two ADRs had superseded. Every
 * one of those was mechanically checkable.
 */
const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const countFiles = (dir: string, match: RegExp) =>
  readdirSync(join(root, dir)).filter((f) => match.test(f)).length;

const HANDBOOK = readdirSync(join(root, 'docs/handbook')).filter((f) => f.endsWith('.md')).sort();

describe('docs — counted figures match reality', () => {
  /** Counts live in ONE place: the generated block in docs/README.md.
   *  Anywhere else they rot silently. */
  const readme = read('docs/README.md');
  const block = /<!-- generated:counts -->([\s\S]*?)<!-- \/generated -->/.exec(readme);

  /** `- migrations: 35` -> 35 */
  const stated = (key: string): number => {
    const m = new RegExp(`^-\\s*${key}:\\s*(\\d+)`, 'm').exec(block?.[1] ?? '');
    if (!m) throw new Error(`docs/README.md's counts block has no "${key}" line`);
    return Number(m[1]);
  };

  it('docs/README.md carries the generated counts block', () => {
    expect(block, 'the <!-- generated:counts --> block is missing').toBeTruthy();
  });

  it('states the real migration count', () => {
    expect(stated('migrations')).toBe(countFiles('supabase/migrations', /\.sql$/));
  });

  it('states the real ADR count', () => {
    expect(stated('adrs')).toBe(countFiles('docs/adr', /^\d{4}-.*\.md$/));
  });

  it('states the real lib module count', () => {
    const actual = readdirSync(join(root, 'lib'), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    expect(stated('lib_modules')).toBe(actual);
  });

  it('states the real e2e spec count', () => {
    expect(stated('e2e_specs')).toBe(countFiles('e2e', /\.spec\.ts$/));
  });

  it('states the real route handler count', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${dir}/${e.name}`);
        else if (e.name === 'route.ts') found.push(`${dir}/${e.name}`);
      }
    };
    walk('app');
    expect(stated('route_handlers')).toBe(found.length);
  });
});

describe('docs — internal links resolve', () => {
  const docs = [
    'README.md',
    'docs/README.md',
    'docs/adr/README.md',
    ...HANDBOOK.map((f) => `docs/handbook/${f}`),
  ];

  it.each(docs)('%s has no broken relative links', (doc) => {
    const body = read(doc);
    const dir = join(root, doc, '..');
    const broken = [...body.matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)(?:#[^)]*)?\)/g)]
      .map((m) => m[1].trim())
      .filter((target) => !existsSync(join(dir, target)));
    expect(broken).toEqual([]);
  });
});

describe('docs — coverage', () => {
  it('every lib/ module appears in the module map', () => {
    const map = read('docs/handbook/04-module-map.md');
    const modules = readdirSync(join(root, 'lib'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(modules.filter((m) => !map.includes(`lib/${m}`))).toEqual([]);
  });

  it('every ADR appears in the index', () => {
    const index = read('docs/adr/README.md');
    const adrs = readdirSync(join(root, 'docs/adr')).filter((f) => /^\d{4}-.*\.md$/.test(f));
    expect(adrs.filter((f) => !index.includes(f))).toEqual([]);
  });

  it('every handbook page is reachable from the site manifest', () => {
    const manifest = JSON.parse(read('docs/site.manifest.json'));
    const listed = new Set(manifest.sections.flatMap((s: { pages: { path: string }[] }) => s.pages.map((p) => p.path)));
    expect(HANDBOOK.map((f) => `docs/handbook/${f}`).filter((p) => !listed.has(p))).toEqual([]);
  });

  it('every table in a migration appears in the data model', () => {
    const model = read('docs/handbook/06-data-model.md');
    const tables = new Set<string>();
    for (const f of readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql'))) {
      for (const m of read(`supabase/migrations/${f}`).matchAll(/create table (?:if not exists )?retrospeq\.(\w+)/g)) {
        tables.add(m[1]);
      }
    }
    expect([...tables].filter((t) => !model.includes(t))).toEqual([]);
  });
});

describe('docs — claims that must not come back', () => {
  /** Each of these was true once and is now actively misleading. */
  const forbidden: [RegExp, string][] = [
    [/create-next-app/i, 'the stock Next.js boilerplate README'],
    [/shared (dev )?supabase project/i, 'the shared project arrangement superseded by ADR 0045'],
    [/vbuzudbipftgsuosreuy/i, 'a deleted Supabase project reference'],
  ];

  it.each(['README.md', ...HANDBOOK.map((f) => `docs/handbook/${f}`)])('%s makes no superseded claim', (doc) => {
    const body = read(doc);
    const hits = forbidden.filter(([re]) => re.test(body)).map(([, what]) => what);
    expect(hits).toEqual([]);
  });
});

describe('docs — mermaid blocks are well formed', () => {
  const KINDS = ['flowchart', 'sequenceDiagram', 'erDiagram', 'stateDiagram-v2', 'graph'];

  it.each(HANDBOOK.map((f) => `docs/handbook/${f}`))('%s has parseable diagrams', (doc) => {
    const body = read(doc);
    for (const m of body.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
      const diagram = m[1].trim();
      expect(KINDS.some((k) => diagram.startsWith(k)), `unknown diagram type in ${doc}`).toBe(true);
      const opens = (diagram.match(/^\s*subgraph\b/gm) || []).length;
      const ends = (diagram.match(/^\s*end\s*$/gm) || []).length;
      expect(ends, `unbalanced subgraph/end in ${doc}`).toBeGreaterThanOrEqual(opens);
    }
  });
});

describe('docs — the silently-skipped test trap', () => {
  it('no *.test.tsx exists anywhere (vitest only includes *.test.ts)', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.test.tsx')) found.push(p);
      }
    };
    walk('lib');
    walk('app');
    expect(found).toEqual([]);
  });
});
