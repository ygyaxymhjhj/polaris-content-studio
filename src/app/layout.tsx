import type { Metadata } from "next";
import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Polaris Content Studio",
  description: "AI content repurposing and growth workspace"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme is server-rendered as light and then corrected by the script below before the
    // first paint; suppressHydrationWarning lets React accept that correction instead of reverting it.
    <html lang="en" translate="no" data-theme="light" data-theme-mode="auto" suppressHydrationWarning>
      <head>
        {/* Resolves the stored mode against the device clock before anything is painted. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
