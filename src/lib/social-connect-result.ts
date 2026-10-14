export const CONNECTION_OUTCOMES = ["returned", "invalid", "unauthenticated", "error", "unconfirmed", "conflict"] as const;
export const AUTHORIZATION_POPUP_STORAGE_KEY = "polaris-postiz-authorization-popup";

export type ConnectionOutcome = typeof CONNECTION_OUTCOMES[number];

export const CONNECTION_MESSAGES: Record<ConnectionOutcome, string> = {
  returned: "Authorisation completed. Your social account is connected to your Polaris user.",
  invalid: "The authorisation return expired or belongs to another session. Please start again.",
  unauthenticated: "Your Polaris session expired. Sign in again in the workspace, then restart authorisation.",
  error: "Polaris could not verify the account connection. No successful connection has been confirmed. Retry the return check or start again.",
  unconfirmed: "No new account was confirmed. Finish authorisation on the platform, then retry the return check.",
  conflict: "This social account belongs to another Polaris user and was not added to your account. Ask a workspace administrator for help."
};

export function parseConnectionOutcome(value: unknown): ConnectionOutcome {
  return CONNECTION_OUTCOMES.find(outcome => outcome === value) ?? "invalid";
}

export function getConnectionReturnPath(value: unknown): string {
  const allowedViews = ["workspace", "facts", "assets", "export", "accounts", "settings"];
  const view = typeof value === "string" && allowedViews.includes(value) ? value : "workspace";
  return `/?view=${view}`;
}

export function getConnectionRetryPath(outcome: ConnectionOutcome, value: unknown): string | null {
  if (outcome !== "error" && outcome !== "unconfirmed") return null;
  return typeof value === "string" && value.length === "/api/social/connect?state=".length + 64 && /^\/api\/social\/connect\?state=[a-f0-9]{64}$/.test(value) ? value : null;
}
