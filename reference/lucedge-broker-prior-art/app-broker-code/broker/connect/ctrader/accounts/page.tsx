import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { peekPendingAccounts } from "@/lib/broker/ctrader/oauthState";
import { AccountsClient } from "./AccountsClient";

export default async function CtraderAccountsPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/sign-up?mode=signin");
  }

  const pending = await peekPendingAccounts();
  if (!pending || pending.accounts.length === 0) {
    redirect("/broker");
  }

  return <AccountsClient accounts={pending.accounts} />;
}
