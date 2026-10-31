"use client";

import { useT } from "@/lib/i18n";
import type { MentionCandidate, MentionGroup } from "@/lib/mentions";
import type { MessageMention } from "@nema/shared";

const GROUP_LABEL = { entry: "mention.entries", attachment: "mention.attachments", thread: "mention.threads" } as const;

/** A mention the composer will send, shown above the box the way an attachment chip is. */
export type MentionChip = { mention: MessageMention; label: string };

function Chip({ chip, onRemove }: { chip: MentionChip; onRemove: () => void }) {
  const t = useT();
  return (
    <li className="att-item ment-item" data-testid="mention-chip">
      <span className="att-name">{chip.label}</span>
      <button type="button" className="att-remove" aria-label={t("mention.remove", { name: chip.label })} onClick={onRemove}>
        ×
      </button>
    </li>
  );
}

/** The mentions of the message being written; × removes the mention and its text from the body. */
export function MentionTray({ chips, onRemove }: { chips: readonly MentionChip[]; onRemove: (index: number) => void }) {
  const t = useT();
  if (chips.length === 0) return null;
  return (
    <div className="att-tray ment-tray" aria-label={t("mention.tray")}>
      <ul className="att-items">
        {chips.map((chip, i) => (
          <Chip key={`${chip.mention.type}:${chip.mention.id}:${i}`} chip={chip} onRemove={() => onRemove(i)} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The `@` menu: one listbox with the three groups (entries, files, topics). Rows are chosen by click, Enter or
 * Tab; ↑/↓ move; Esc closes. It never renders when every group is empty.
 */
export function MentionMenu({
  groups,
  active,
  onChoose,
  onHover,
  empty,
}: {
  groups: readonly MentionGroup[];
  active: number;
  onChoose: (candidate: MentionCandidate) => void;
  onHover: (index: number) => void;
  /**
   * What to say when no row is shown. `state` separates "the hub is still answering" and "the lookup failed"
   * from a real answer; `entries`/`attachments` then say whether the workspace has any at all, and `query`
   * lets "no match for this text" be said instead of "there is nothing here".
   */
  empty: {
    entries: boolean;
    attachments: boolean;
    state: "idle" | "loading" | "ok" | "failed";
    query: string;
  };
}) {
  const t = useT();
  const rows = groups.flatMap((g) => g.items);
  if (rows.length === 0) {
    const message =
      empty.state === "loading"
        ? t("mention.looking")
        : empty.state === "failed"
          ? t("mention.lookupFailed")
          : empty.query !== ""
            ? t("mention.noMatch", { query: empty.query })
            : [
                empty.entries ? null : t("mention.emptyEntries"),
                empty.attachments ? null : t("mention.emptyAttachments"),
              ].filter(Boolean).join(" ") || t("mention.noMatch", { query: "" });
    return (
      <div className="cmdmenu ment-menu" id="mention-commands" role="listbox" aria-label={t("mention.menu")}>
        <p className="ment-empty" role="presentation">{message}</p>
      </div>
    );
  }
  // The flat index of each row across the groups, so the keyboard and the highlight agree.
  const offset = groups.reduce<number[]>((acc, g, i) => [...acc, (acc[i - 1] ?? 0) + (groups[i - 1]?.items.length ?? 0)], []);
  return (
    <div className="cmdmenu ment-menu" id="mention-commands" role="listbox" aria-label={t("mention.menu")}>
      {groups.map((group, gi) =>
        group.items.length === 0 ? null : (
          <div key={group.kind}>
            <div className="cmdgroup" role="presentation">
              {t(GROUP_LABEL[group.kind])}
            </div>
            {group.items.map((item, ii) => {
              const i = offset[gi]! + ii;
              return (
                <button
                  key={`${item.type}:${item.id}`}
                  type="button"
                  role="option"
                  id={`mention-${item.type}-${item.id}`}
                  aria-selected={i === active}
                  className={i === active ? "on" : ""}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onChoose(item)}
                >
                  <span className="name">{item.label}</span>
                  <span className="hint">{item.hint}</span>
                </button>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}
