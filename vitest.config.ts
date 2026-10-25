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
// The local package and the CLI's narrow permissions helper are tested from source.
alias["@nema/local"] = `${root}apps/local/src/instance.ts`;
alias["@nema/shared/ownedHelper"] = `${root}packages/shared/src/ownedHelper.ts`;
alias["@nema/cli/secrets/permissions"] = `${root}apps/cli/src/secrets/permissions.ts`;
alias["@nema/hub/db/local"] = `${root}apps/hub/src/db/pglite.ts`;
alias["@nema/hub/db/snapshot"] = `${root}apps/hub/src/db/snapshot.ts`;
alias["@nema/hub/db/export"] = `${root}apps/hub/src/db/export.ts`;
alias["@nema/hub/events"] = `${root}apps/hub/src/events.ts`;
alias["@nema/hub/interrupts"] = `${root}apps/hub/src/interrupts.ts`;
alias["@nema/hub/lifecycle"] = `${root}apps/hub/src/lifecycle.ts`;
alias["@nema/hub/messages"] = `${root}apps/hub/src/messages.ts`;
alias["@nema/hub/tasks"] = `${root}apps/hub/src/tasks.ts`;
alias["@nema/hub/workspaces"] = `${root}apps/hub/src/workspaces.ts`;
alias["@nema/cli/config"] = `${root}apps/cli/src/config.ts`;
alias["@nema/cli/daemon/setup"] = `${root}apps/cli/src/daemon/setup.ts`;

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
  resolve: { alias: [
    { find: /^@nema\/shared\/ownedHelper$/, replacement: `${root}packages/shared/src/ownedHelper.ts` },
    ...Object.entries(alias).map(([find, replacement]) => ({ find, replacement })),
  ] },
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
          exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/._*"],
          ...(isWeb ? { environment: "jsdom", setupFiles: [`${root}${dir}/test/setup.ts`] } : {}),
        },
      };
    }),
  },
});
