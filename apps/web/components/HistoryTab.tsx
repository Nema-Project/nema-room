"use client";

import { diffLines } from "diff";
import { useEffect, useMemo, useState } from "react";
import { formatDay, formatTime } from "@/lib/format";
import { getVersion } from "@/lib/hub";
import { useLocale, useT } from "@/lib/i18n";
import type { Entry, HistoryItem } from "@/lib/types";

type Props = {
  workspaceId: string;
  entryId: string;
  history: HistoryItem[];
  current: Entry;
  /** Version preselected on mount (e.g. coming from the Why tab). */
  initialVersion?: number | null;
};

export function HistoryTab({ workspaceId, entryId, history, current, initialVersion = null }: Props) {
  const t = useT();
  const [locale] = useLocale();
  const [selected, setSelected] = useState<number | null>(initialVersion);
  // The result is tagged with the commit it was fetched for, so a different selection starts from nothing without a reset.
  const [fetched, setFetched] = useState<{ commit: string; entry: Entry | null; error: string | null } | null>(null);
  const item = history.find((h) => h.version === selected);
  const currentVersion = history[0]?.version;
  const forItem = item && fetched?.commit === item.commit ? fetched : null;
  const old = forItem?.entry ?? null;
  const error = forItem?.error ?? null;

  useEffect(() => {
    if (!item) return;
    const commit = item.commit;
    let live = true;
    getVersion(workspaceId, entryId, commit).then(
      (e) => live && setFetched({ commit, entry: e, error: null }),
      (e) => live && setFetched({ commit, entry: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, entryId, item?.commit]); // eslint-disable-line react-hooks/exhaustive-deps

  const parts = useMemo(() => (old ? diffLines(old.body, current.body) : null), [old, current.body]);

  if (history.length === 0) return <p className="placeholder">{t("history.empty")}</p>;
  return (
    <div className="hist">
      {history.map((h) => {
        const at = new Date(h.committedAt);
        return (
          <button
            key={h.version}
            type="button"
            data-testid="version-row"
            className={h.version === selected ? "vrow on" : "vrow"}
            aria-pressed={h.version === selected}
            onClick={() => setSelected(h.version)}
          >
            <span className="vnum">{`v${h.version}`}</span>
            <span className="vtime">{`${formatDay(at, locale)} ${formatTime(at, locale)}`}</span>
            <span className={h.author === "user" ? "atag user" : "atag"} data-author={h.author}>{t(`author.${h.author}`)}</span>
            <span className="vreason">{h.reason}</span>
            {h.sourceMessages.length > 0 && <span className="vsrc">{h.sourceMessages.join(", ")}</span>}
          </button>
        );
      })}
      {item && (
        <div className="diff">
          <div className="diff-title">{t("history.diffTitle", { from: item.version, to: currentVersion ?? "" })}</div>
          {error && <p className="error">{error}</p>}
          {parts && !parts.some((p) => p.added || p.removed) && <p className="placeholder">{t("history.identical")}</p>}
          {parts?.flatMap((p, i) =>
            p.value
              .replace(/\n$/, "")
              .split("\n")
              .map((line, j) => {
                const kind = p.added ? "add" : p.removed ? "del" : "same";
                return (
                  <div key={`${i}-${j}`} className={`dl ${kind}`} data-diff={kind}>
                    <span className="sign">{kind === "add" ? "+" : kind === "del" ? "−" : ""}</span>
                    <span className="txt">{line}</span>
                  </div>
                );
              }),
          )}
        </div>
      )}
    </div>
  );
}
