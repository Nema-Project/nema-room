import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionRecord } from "@nema/shared";
import { openExtensionStore } from "../../src/extensions/store.js";

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export function skillText(name: string, description = `Does ${name} things.`, body = `# ${name}\n\nFollow these steps.\n`, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`;
}

export function record(id: string, o: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id,
    kind: "skill",
    name: id,
    summary: `Does ${id} things.`,
    source: `https://github.com/acme/skills/tree/${COMMIT}/${id}`,
    revision: COMMIT,
    provision: "managed",
    installState: "installed",
    useState: "enabled",
    availability: "ready",
    externalPath: null,
    error: null,
    ...o,
  };
}

/** A managed Skill in `<nemaHome>/extensions/extensions/<id>` with the given files (SKILL.md included). */
export function managedSkill(nemaHome: string, id: string, files: Record<string, string | Buffer>, o: Partial<ExtensionRecord> = {}): string {
  const store = openExtensionStore(join(nemaHome, "extensions"));
  store.putManaged(record(id, o));
  const root = join(nemaHome, "extensions", "extensions", id);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...rel.split("/")), content);
  }
  return root;
}

/** An attached folder somewhere else on disk. `folder` must be a real path. */
export function externalSkill(nemaHome: string, id: string, folder: string, files: Record<string, string | Buffer>): string {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(folder, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(folder, ...rel.split("/")), content);
  }
  const store = openExtensionStore(join(nemaHome, "extensions"));
  store.attachExternal(record(id, { provision: "external", externalPath: folder, source: folder, revision: "local" }));
  return folder;
}
