import { NextResponse } from "next/server";
import { fetchPostizIntegrations, getPostizUiUrl, isPostizOAuthConfigured } from "@/lib/postiz";
import { currentUser, unauthorized } from "@/lib/auth";
import { listAccountOwners, syncSocialAccounts } from "@/lib/social-accounts";
import type { SocialAccount } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Channels stay live from Postiz and are only decorated with local ownership: the registry never
 * becomes the source of the list, so a channel deleted in Postiz disappears here immediately.
 * Members receive only the channels they own; administrators receive everything plus the owner name.
 */
export async function GET() {
  const auth = await currentUser();
  if (!auth) return unauthorized();
  const result = await fetchPostizIntegrations();
  const uiUrl = getPostizUiUrl();
  const oauthConfigured = isPostizOAuthConfigured();
  const headers = { "Cache-Control": "no-store" };
  if (!result.configured || result.error) {
    // Postiz unreachable: report the error rather than falling back to registry rows, which could
    // keep showing channels that were deleted or are no longer visible to this viewer.
    return NextResponse.json({ ...result, uiUrl, oauthConfigured }, { headers });
  }
  try {
    await syncSocialAccounts(result.accounts);
    const owners = await listAccountOwners();
    const decorated: SocialAccount[] = result.accounts.map((account) => {
      const record = owners.get(account.id);
      return { ...account, ownerUserId: record?.ownerUserId ?? null, ownerName: record?.ownerName ?? null };
    });
    const accounts = auth.user.role === "admin" ? decorated : decorated.filter((account) => account.ownerUserId === auth.user.id);
    return NextResponse.json({ ...result, accounts, uiUrl, oauthConfigured }, { headers });
  } catch (error) {
    // Fail closed: without ownership data no member may see any channel, administrators included.
    // The failure stays in the server log; the response carries no error text, so members never
    // see raw internal messages — the empty list simply reads as "no accounts yet".
    console.error("[social/channels] ownership sync failed", error);
    return NextResponse.json({ configured: true, accounts: [], uiUrl, oauthConfigured }, { headers });
  }
}
