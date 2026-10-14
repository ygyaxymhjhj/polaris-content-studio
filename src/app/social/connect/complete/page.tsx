import type { Metadata } from "next";
import { getConnectionRetryPath, getConnectionReturnPath, parseConnectionOutcome } from "@/lib/social-connect-result";
import ConnectionComplete from "./ConnectionComplete";

export const metadata: Metadata = {
  title: "Social account authorisation | Polaris",
  referrer: "no-referrer"
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ConnectionCompletePage({ searchParams }: Props) {
  const parameters = await searchParams;
  const outcome = parseConnectionOutcome(parameters.connection);

  return (
    <ConnectionComplete
      outcome={outcome}
      returnPath={getConnectionReturnPath(parameters.view)}
      retryPath={getConnectionRetryPath(outcome, parameters.retry)}
    />
  );
}
