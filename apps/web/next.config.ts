import type { NextConfig } from "next";

// Share the repo-root .env (see .env.example) with the web app. Existing env vars win.
try {
  process.loadEnvFile("../../.env"); // next dev/build run with cwd = apps/web
} catch {
  // no root .env: fall back to defaults / apps/web/.env
}

const nextConfig: NextConfig = {
  // Next 16 otherwise regenerates apps/web/AGENTS.md on `next dev`.
  agentRules: false,
};

export default nextConfig;
