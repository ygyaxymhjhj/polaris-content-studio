import { redirect } from "next/navigation";
import ContentStudio from "@/components/ContentStudio";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ claimed?: string }> }) {
  const auth = await currentUser();
  if (!auth) redirect("/login");
  // Set by the sign-in redirect when anonymous projects were adopted into this account.
  const claimed = Number((await searchParams).claimed) || 0;
  return <ContentStudio user={auth.user} claimedProjects={claimed} />;
}
