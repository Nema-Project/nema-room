"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AttachProblem, ExtensionRecord, SkillDiscovery } from "@nema/shared";
import { attachExtension, discoverExtensions, pickDirectory } from "@/lib/hub";
import { useT } from "@/lib/i18n";

const PROBLEMS: ReadonlySet<string> = new Set<AttachProblem>([
  "missing-frontmatter",
  "invalid-id",
  "bundled-id",
  "id-taken",
  "outside-location",
  "too-large",
  "not-a-folder",
]);

/** The daemon ends a refusal with `: <problem>`; a known problem is shown in the page's language. */
function attachProblem(message: string): AttachProblem | "already-attached" | null {
  if (message.startsWith("already attached")) return "already-attached";
  const code = /: ([a-z-]+)$/.exec(message)?.[1];
  return code && PROBLEMS.has(code) ? (code as AttachProblem) : null;
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

/**
 * Skills other agents keep on this computer, and a way to attach one by reference.
 *
 * Attaching writes a record that names the folder's real path; nothing is copied, and Remove from
 * list later drops only the record. The list is read again whenever the page's records change, so
 * an item someone detached shows its Attach button again.
 */
export function ExternalSkillsPanel({ records, onAttached }: { records: ExtensionRecord[] | null; onAttached: (record: ExtensionRecord) => void }) {
  const t = useT();
  const [found, setFound] = useState<SkillDiscovery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reads = useRef(0);
  // Null until the page's list has loaded, so the first read waits for it instead of running twice.
  const key = records === null ? null : records.map((row) => `${row.id}\u0000${row.externalPath ?? ""}`).join("\n");

  useEffect(() => {
    if (key === null) return;
    const mine = ++reads.current;
    discoverExtensions()
      .then((result) => {
        if (reads.current !== mine) return;
        setFound(result);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (reads.current !== mine) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      });
  }, [key]);

  useEffect(() => () => {
    // A read that answers after the page closed must not set state.
    reads.current += 1;
  }, []);

  const describe = (message: string) => {
    const problem = attachProblem(message);
    if (problem === "already-attached") return t("extensions.found.already");
    return problem ? t(`extensions.attach.problem.${problem}`) : message;
  };

  const attach = (target: string) => {
    if (pending) return;
    setPending(target);
    setError(null);
    attachExtension(target)
      .then((record) => {
        if (target === folder.trim()) setFolder("");
        onAttached(record);
      })
      .catch((e: unknown) => setError(describe(e instanceof Error ? e.message : String(e))))
      .finally(() => setPending(null));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = folder.trim();
    if (target) attach(target);
  };

  const choose = () => {
    setError(null);
    pickDirectory()
      .then((chosen) => {
        if (chosen.path) setFolder(chosen.path);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="plugin-block external-skills" role="region" aria-label={t("extensions.found.title")}>
      <h3>{t("extensions.found.title")}</h3>
      <p className="plugin-note">{t("extensions.found.note")}</p>
      {loadError && <p className="error">{loadError}</p>}
      {!found && !loadError && <p className="kmeta">{t("common.loading")}</p>}
      {found && found.skills.length === 0 && (
        <p className="kmeta">{t("extensions.found.none", { locations: found.locations.map((location) => location.path).join(", ") })}</p>
      )}
      {found && found.skills.length > 0 && (
        <ul className="skill-preview">
          {found.skills.map((skill) => (
            <li key={skill.path}>
              <h4>{skill.name ?? folderName(skill.path)}</h4>
              {skill.description && <p>{skill.description}</p>}
              <p className="kmeta">{skill.path}</p>
              {skill.attached ? (
                <p className="kmeta">{t("extensions.found.attached")}</p>
              ) : skill.problem ? (
                <p className="plugin-note">{t(`extensions.attach.problem.${skill.problem}`)}</p>
              ) : (
                <button
                  type="button"
                  className="sp"
                  aria-label={t("extensions.found.attach-named", { name: skill.name ?? folderName(skill.path) })}
                  onClick={() => attach(skill.path)}
                  disabled={pending !== null}
                >
                  {t("extensions.found.attach")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {found?.truncated && <p className="plugin-note">{t("extensions.found.truncated")}</p>}
      <form className="field" onSubmit={submit}>
        <label>
          <span className="label">{t("extensions.found.other")}</span>
          <input type="text" value={folder} placeholder={t("extensions.found.placeholder")} onChange={(e) => setFolder(e.target.value)} disabled={pending !== null} />
        </label>
        <button type="button" className="sp" onClick={choose} disabled={pending !== null}>
          {t("extensions.found.choose")}
        </button>
        <button type="submit" className="sp" disabled={pending !== null || !folder.trim()}>
          {t("extensions.found.attach-folder")}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
