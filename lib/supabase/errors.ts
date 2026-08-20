/**
 * Thrown by every client factory in `lib/supabase/` when a required env
 * var is absent, instead of falling back to a placeholder connection.
 * AGENTS.md "When something needs the owner — never fake it, always
 * flag it": a Supabase client built against a missing URL/key would
 * fail confusingly deep inside `@supabase/*` — this fails immediately,
 * at the boundary, naming exactly what's missing.
 */
export class SupabaseNotConfiguredError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `Supabase client cannot be created — missing env var(s): ${missing.join(', ')}. ` +
        'See .env.local.example / docs/adr/0002-shared-dev-supabase-project.md.',
    );
    this.name = 'SupabaseNotConfiguredError';
    this.missing = missing;
  }
}

/** Throws SupabaseNotConfiguredError if any of `names` is unset. */
export function requireEnv(names: readonly string[]): Record<string, string> {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new SupabaseNotConfiguredError(missing);
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name] as string]));
}
