import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '../(auth)/actions';

/**
 * Minimal authenticated shell for the app proper (as opposed to
 * app/(auth)/layout.tsx's signed-out card layout). This slice only
 * needs enough chrome to host the accounts screens — a full nav/tab bar
 * is a later module's job, not this one's (dispatch: "keep it minimal,
 * this slice is about the connect flow not general app chrome").
 *
 * Auth guard lives here, not in proxy.ts: proxy.ts's own job is only
 * session-cookie refresh (see that file's header comment) — route
 * protection for the authenticated route group belongs in the group's
 * own layout, the standard Next.js App Router pattern for this.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <Link href="/accounts" className="rq-h2">
          Retrospeq
        </Link>
        <form action={signOut}>
          <button type="submit" className="rq-btn rq-btn--ghost">
            Sign out
          </button>
        </form>
      </header>
      <main className="flex flex-1 flex-col p-6">{children}</main>
    </div>
  );
}
