/**
 * Shared shell for /signup, /login, /reset-password,
 * /reset-password/confirm and /mfa-challenge. Frames 6.1–6.3
 * (`brand/docs/screens/account.html`) show the signed-out screens as
 * the phone-width column itself — ground, not a card on ground — with
 * the `.auth` stack doing all the layout, so this layout only centres
 * that column and gets out of the way.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-[32rem] flex-1 flex-col justify-center px-5 py-8">
      {children}
    </main>
  );
}
