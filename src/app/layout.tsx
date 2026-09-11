import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polaris Content Studio",
  description: "AI content repurposing and growth workspace"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" translate="no" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
