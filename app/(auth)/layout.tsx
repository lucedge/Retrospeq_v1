/**
 * Shared shell for /signup, /login, /reset-password,
 * /reset-password/confirm and /mfa-challenge. Frames 6.1–6.3
 * (`brand/docs/screens/account.html`) show the signed-out screens as
 * the phone-width column itself — ground, not a card on ground — with
 * the `.auth` stack doing all the layout, so this layout only centres
 * that column and gets out of the way.
 *
 * Width is `--rq-auth-max`, which deliberately does NOT follow the app
 * shell's widening steps (`--rq-shell-max`, ADR 0047): a sign-in form
 * gains nothing from 48rem and loses the short scan the frames were
 * drawn for. What the wider viewport buys here is air — more vertical
 * padding — not a wider card.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-[var(--rq-auth-max)] flex-1 flex-col justify-center px-5 py-8 tablet:py-12">
      {children}
    </main>
  );
}
