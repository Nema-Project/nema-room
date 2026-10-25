import type { NextConfig } from "next";

const managedLocalBuild = process.env.NEMA_MANAGED_LOCAL_BUILD === "1";

// Developer and Compose builds share the repo-root .env (see .env.example).
// The managed build runs in a sanitized source snapshot and must not load checkout secrets.
if (!managedLocalBuild) {
  try {
    process.loadEnvFile("../../.env"); // next dev/build run with cwd = apps/web
  } catch {
    // no root .env: fall back to defaults / apps/web/.env
  }
}

const nextConfig: NextConfig = {
  // Next 16 otherwise regenerates apps/web/AGENTS.md on `next dev`.
  agentRules: false,
  ...(managedLocalBuild ? { output: "standalone" } : {}),
};

export default nextConfig;
