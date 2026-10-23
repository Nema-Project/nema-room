import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// npm nests @vitejs/plugin-react under apps/web (its vite peer conflicts with the root's), so resolve it from there.
const webDir = `${root}apps/web`;
const react = existsSync(webDir)
  ? (createRequire(`${webDir}/package.json`)("@vitejs/plugin-react") as typeof import("@vitejs/plugin-react")).default
  : undefined;

// Resolve workspace packages to source so tests need no prior `tsc -b`.
const alias: Record<string, string> = {};
for (const d of readdirSync(`${root}packages`, { withFileTypes: true })) {
  const entry = `${root}packages/${d.name}/src/index.ts`;
  if (d.isDirectory() && existsSync(entry)) alias[`@nema/${d.name}`] = entry;
}

// One project per workspace dir. Inline projects with `extends: true` inherit the alias above
// (glob-discovered projects would not).
const workspaceDirs = ["packages", "apps"].flatMap((g) =>
  existsSync(`${root}${g}`)
    ? readdirSync(`${root}${g}`, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(`${root}${g}/${d.name}/package.json`))
        .map((d) => `${g}/${d.name}`)
    : [],
);

export default defineConfig({
  resolve: { alias },
  test: {
    // Real git, PGlite and child processes run in every project; under a full parallel run a single
    // test can pass 5s on a busy machine without being stuck.
    testTimeout: 20_000,
    projects: workspaceDirs.map((dir) => {
      const isWeb = dir === "apps/web";
      return {
        extends: true as const,
        // The web app is the only browser-like project: jsdom + React + its `@/` import alias.
        ...(isWeb ? { plugins: react ? [react()] : [], resolve: { alias: { "@": `${root}${dir}` } } } : {}),
        test: {
          name: `@nema/${dir.split("/")[1]}`,
          root: `${root}${dir}`,
          exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
          ...(isWeb ? { environment: "jsdom", setupFiles: [`${root}${dir}/test/setup.ts`] } : {}),
        },
      };
    }),
  },
});
