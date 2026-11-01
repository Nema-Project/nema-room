/** The slice of a Skill the plugin page and the `/` menu can warn about. */
export type SkillLimitSource = {
  runtimes?: ReadonlyArray<{ adapter: string; missing?: readonly string[] | null }> | null;
  diagnostics?: readonly string[] | null;
};

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function named(t: Translate, key: string, fallback: string): string {
  const text = t(key);
  return text === key ? fallback : text;
}

/**
 * What to say when a Skill is installed but only partly usable.
 * Runtime gaps come from `missing`. The only diagnostic shown is `name-folder-mismatch`;
 * other codes stay on the payload and off the page.
 */
export function skillLimitLines(skill: SkillLimitSource | null | undefined, t: Translate): string[] {
  if (!skill) return [];
  const lines: string[] = [];
  for (const runtime of skill.runtimes ?? []) {
    const missing = (runtime.missing ?? []).filter((gap) => gap.length > 0);
    if (missing.length === 0) continue;
    const gaps = missing.map((gap) => named(t, `skills.gap.${gap}`, gap)).join(", ");
    lines.push(t("skills.limit.missing", { runtime: named(t, `skills.runtime.${runtime.adapter}`, runtime.adapter), gaps }));
  }
  if ((skill.diagnostics ?? []).includes("name-folder-mismatch")) lines.push(t("skills.diagnostic.name-folder-mismatch"));
  return lines;
}
