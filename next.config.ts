import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  // Keep production builds from overwriting a running development server.
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
  typescript: {
    tsconfigPath: phase === PHASE_DEVELOPMENT_SERVER ? "tsconfig.json" : "tsconfig.build.json"
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb"
    }
  }
});

export default nextConfig;
