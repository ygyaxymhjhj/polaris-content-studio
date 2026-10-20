import type { Platform, SocialAccount } from "./types";

const accountPlatforms = new Map<string, Platform>([
  ["x", "x"],
  ["twitter", "x"],
  ["threads", "threads"],
  ["facebook", "facebook"],
  ["linkedin", "linkedin"],
  ["linkedin-page", "linkedin"],
  ["instagram", "instagram"],
  ["instagram-standalone", "instagram"]
]);

export function getSocialAccountPlatform(identifier: string): Platform | null {
  return accountPlatforms.get(identifier.trim().toLowerCase()) ?? null;
}

export function getMatchingSocialAccounts(accounts: readonly SocialAccount[], platform: Platform | null | undefined): SocialAccount[] {
  if (!platform) return [];
  return accounts.filter(account => !account.disabled && getSocialAccountPlatform(account.identifier) === platform);
}
