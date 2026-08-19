import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { exchangeCodeForTokens } from "@/lib/broker/ctrader/oauth";
import { listAccounts } from "@/lib/broker/ctrader/protoClient";
import { readAndClearPendingConnectState, setPendingAccountsCookie } from "@/lib/broker/ctrader/oauthState";
import { getSupabase } from "@/lib/supabase/server";
import { getClientIp, recordAuthEvent } from "@/lib/auth/lockout";

export const runtime = "nodejs";

function redirectWithError(origin: string, error: string) {
  return NextResponse.redirect(new URL(`/broker?error=${encodeURIComponent(error)}`, origin));
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  // BRK-003: trader denied or cancelled the connection — no rows written.
  if (oauthError) {
    return redirectWithError(origin, "Connection wasn't completed. Try again, or import a CSV instead.");
  }

  const expectedState = await readAndClearPendingConnectState();
  // BRK-004: state mismatch is a possible CSRF attempt — reject outright
  // and log it as a security event. There's no connection_id yet at this
  // point (nothing's been written), so this logs via the same audit trail
  // as auth security events rather than connection_events.
  if (!state || !expectedState || state !== expectedState) {
    const supabase = await getSupabase();
    const { data: userData } = await supabase.auth.getUser();
    const ip = await getClientIp();
    await recordAuthEvent({
      userId: userData.user?.id,
      email: userData.user?.email,
      ip,
      eventType: "broker_oauth_state_mismatch",
      metadata: { broker: "ctrader" },
    });
    return redirectWithError(origin, "Something went wrong with that connection attempt. Please try again.");
  }

  if (!code) {
    return redirectWithError(origin, "Connection wasn't completed. Try again, or import a CSV instead.");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const accounts = await listAccounts(tokens.accessToken);

    if (accounts.length === 0) {
      return redirectWithError(origin, "No trading accounts were found for that cTrader login.");
    }

    await setPendingAccountsCookie({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      accounts,
    });

    return NextResponse.redirect(new URL("/broker/connect/ctrader/accounts", origin));
  } catch {
    // Never leak a raw stack trace to the trader — any protobuf/REST
    // failure in this step gets the same honest-but-generic copy.
    return redirectWithError(origin, "We couldn't connect to cTrader. Please try again.");
  }
}
