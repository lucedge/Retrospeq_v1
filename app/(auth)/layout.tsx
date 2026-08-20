/**
 * Shared shell for /signup, /login, /reset-password and
 * /reset-password/confirm. Plain centred card — this is infrastructure,
 * not a designed screen (per this slice's brief), but it still uses the
 * design system's tokens/typography classes rather than inventing new
 * ones (rq-h1, rq-sub, rq-label, rq-btn).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-6">
      <div className="rq-card w-full max-w-sm">{children}</div>
    </main>
  );
}
