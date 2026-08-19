import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { BrokerClient } from "./BrokerClient";

export default async function BrokerPage() {
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
  if (!user.email_confirmed_at) {
    redirect("/auth/verify");
  }

  const { data: profile } = await supabase
    .from("users")
    .select("onboarded_at")
    .eq("id", user.id)
    .single();

  if (!profile?.onboarded_at) {
    redirect("/onboarding");
  }

  const { data: pendingDeletion } = await supabase
    .from("data_requests")
    .select("id")
    .eq("type", "delete")
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  if (pendingDeletion) {
    redirect("/profile/delete");
  }

  // No M11 billing entitlement check here — M11 doesn't exist yet. Per the
  // M2 spec's fail-open guidance (§10), a missing entitlement check should
  // never block a trader's data; this is simply omitted rather than
  // stubbed, since a stub is exactly the sort of thing someone might later
  // "helpfully" wire up backwards (fail-closed) without re-reading the spec.
  const { data: connections } = await supabase
    .from("broker_connections")
    .select(
      "id, broker, account_type, broker_login, display_label, status, last_synced_at, backfill_completed_at, connected_at",
    )
    .order("created_at", { ascending: true });

  return <BrokerClient connections={connections ?? []} />;
}
