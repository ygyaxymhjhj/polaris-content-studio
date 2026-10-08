import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";
import { currentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in · Polaris Content Studio" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Already signed in: there is nothing to do here.
  if (await currentUser()) redirect("/");
  return <LoginForm />;
}
