#!/usr/bin/env node
// Throwaway confirmed auth user for E2E / manual checks against the shared
// dev Supabase project. Every agent used to reinvent this inline.
//   node --env-file=.env.local scripts/test-user.mjs create <label>   → prints JSON {id,email,password}
//   node --env-file=.env.local scripts/test-user.mjs delete <id|email>
//   node --env-file=.env.local scripts/test-user.mjs cleanup [--hours N] → deletes this repo's test-pattern users created in the last N hours (default 6)
// Deletion order matters: retrospeq.profiles first (under the erasure
// escape hatch, or the freeze trigger blocks it), then the GoTrue user.
import pg from 'pg';

const [, , cmd, ...rest] = process.argv;
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = process.env.SUPABASE_DB_URL;
if (!url || !key || !db) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL — run with --env-file=.env.local'); process.exit(2); }
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
// Anything an agent or test ever created. Real accounts use real domains; every pattern here is a throwaway domain.
const TEST_PATTERNS = ['%@example.com', '%@example.test', '%@retrospeq-e2e.test', '%@example.org', 'delivered+retrospeq-%@resend.dev'];

async function withDb(fn) { const c = new pg.Client({ connectionString: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
async function deleteUser(c, id) {
  try { await c.query('begin'); await c.query(`select set_config('retrospeq.erasure_in_progress','true',true)`); await c.query('delete from retrospeq.profiles where id=$1', [id]); await c.query('commit'); }
  catch (e) { await c.query('rollback'); console.error('profile delete failed', id, e.message); }
  const r = await fetch(`${url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: h });
  return r.ok;
}

if (cmd === 'create') {
  const label = (rest[0] ?? 'user').replace(/[^a-z0-9-]/gi, '');
  const email = `retrospeq-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}A1!`;
  const r = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: h, body: JSON.stringify({ email, password, email_confirm: true }) });
  const body = await r.json();
  if (!r.ok) { console.error('create failed', body); process.exit(1); }
  console.log(JSON.stringify({ id: body.id, email, password }));
} else if (cmd === 'delete') {
  const who = rest[0]; if (!who) { console.error('delete needs <id|email>'); process.exit(2); }
  await withDb(async (c) => {
    const { rows } = await c.query('select id from auth.users where id::text=$1 or email=$1', [who]);
    if (!rows.length) { console.error('no such user'); process.exit(1); }
    console.log(await deleteUser(c, rows[0].id) ? 'deleted' : 'auth delete failed');
  });
} else if (cmd === 'cleanup') {
  const hours = Number(rest[rest.indexOf('--hours') + 1]) || 6;
  await withDb(async (c) => {
    const { rows } = await c.query(`select id, email from auth.users where created_at > now() - ($1 || ' hours')::interval and (${TEST_PATTERNS.map((_, i) => `email like $${i + 2}`).join(' or ')})`, [String(hours), ...TEST_PATTERNS]);
    let ok = 0; for (const { id } of rows) if (await deleteUser(c, id)) ok++;
    console.log(`cleanup: deleted ${ok}/${rows.length} test users from the last ${hours}h`);
  });
} else { console.error('usage: test-user.mjs create <label> | delete <id|email> | cleanup [--hours N]'); process.exit(2); }
