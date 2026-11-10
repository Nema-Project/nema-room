import type { NextConfig } from "next";

const managedLocalBuild = process.env.NEMA_MANAGED_LOCAL_BUILD === "1";
const dockerWeb = process.env.NEMA_DOCKER_WEB === "1";
const standaloneBuild = managedLocalBuild || dockerWeb;

// Developer and Compose builds share the repo-root .env (see .env.example).
// Managed and published image builds must not load checkout secrets.
if (!standaloneBuild) {
  try {
    process.loadEnvFile("../../.env"); // next dev/build run with cwd = apps/web
  } catch {
    // no root .env: fall back to defaults / apps/web/.env
  }
}

const shareHeaders = [
  { key: "Cache-Control", value: "no-store" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'none'" },
];

const nextConfig: NextConfig = {
  // Next 16 otherwise regenerates apps/web/AGENTS.md on `next dev`.
  agentRules: false,
  async headers() {
    return [{ source: "/s/:path*", headers: shareHeaders }];
  },
  ...(standaloneBuild
    ? {
        output: "standalone",
        images: { unoptimized: true },
        // Next's file tracer still follows sharp. Packaging deletes any copy that lands in the payload.
        outputFileTracingExcludes: {
          "*": ["node_modules/sharp/**", "node_modules/@img/**"],
        },
      }
    : {}),
};

export default nextConfig;
