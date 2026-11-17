"use client";

import { Markdown } from "@/components/Markdown";
import { useT } from "@/lib/i18n";

export type ShareListEntry = {
  id: string;
  title: string;
  tags?: string[];
  body?: string;
  status?: string;
  basis?: string | null;
  confirmedAt?: string | null;
  implementationStatus?: string;
  implementationAccepted?: boolean;
  implementationInferred?: boolean;
  workpackage?: {
    blockedOn: string | null;
    taskCount: number;
    tasks?: { n: number; title: string; status: string; inferred: boolean }[];
  };
};

export type ShareEntryView = ShareListEntry & {
  body: string;
  quotes: { text: string }[];
};

export function ShareUnavailable({ temporary }: { temporary?: boolean }) {
  const t = useT();
  return <p>{t(temporary ? "share.temporarilyUnavailable" : "share.linkUnavailable")}</p>;
}

function ShareMetadata({ entry }: { entry: ShareListEntry }) {
  const t = useT();
  const statusKey = ["draft", "approved", "in_progress", "done"].includes(entry.status ?? "") ? "wp.status" : "status";
  const implementation = entry.implementationStatus === "verified"
    ? t(entry.implementationAccepted === true ? "share.acceptedByUser" : "share.commitsCheckedOnly")
    : entry.implementationStatus ? t(`impl.${entry.implementationStatus}`) : null;
  return (
    <dl>
      {!!entry.tags?.length && <><dt>{t("tags.title")}</dt><dd>{entry.tags.map(tag => <a key={tag} href={`?tag=${encodeURIComponent(tag)}`}>#{tag} </a>)}</dd></>}
      {entry.status && <><dt>{t("share.entryStatus")}</dt><dd>{t(`${statusKey}.${entry.status}`)}</dd></>}
      {entry.basis && <><dt>{t("detail.basis")}</dt><dd>{t(`basis.${entry.basis}`)}</dd></>}
      {entry.confirmedAt && <><dt>{t("detail.confirmedAt")}</dt><dd><time dateTime={entry.confirmedAt}>{entry.confirmedAt}</time></dd></>}
      {(implementation || entry.implementationAccepted || entry.implementationInferred) && <>
        <dt>{t("impl.title")}</dt>
        <dd>
          {implementation && <span>{implementation}</span>}
          {entry.implementationAccepted === true && entry.implementationStatus !== "verified" && <>{implementation && " · "}<span>{t("share.acceptedByUser")}</span></>}
          {entry.implementationInferred && <> · <span>{t("basis.inferred")}</span></>}
        </dd>
      </>}
    </dl>
  );
}

/** Read-only knowledge. It must not import the private hub client. */
export function ShareView({
  token,
  workspaceName,
  entries,
  entry,
  selectedTag,
}: {
  token: string;
  workspaceName: string;
  entries: ShareListEntry[];
  entry?: ShareEntryView;
  selectedTag?: string;
}) {
  const t = useT();
  return (
    <main>
      <h1>{workspaceName}</h1>
      {selectedTag !== undefined && <a href="?">{t("tags.clear")}</a>}
      {!entries.length && <p>{t("tags.empty")}</p>}
      <ul>
        {entries.map((item) => (
          <li key={item.id}>
            <a href={`/s/${token}/e/${item.id}`}>{item.title}</a>
            <ShareMetadata entry={item} />
          </li>
        ))}
      </ul>
      {entry ? (
        <article>
          <h2>{entry.title}</h2>
          <ShareMetadata entry={entry} />
          <Markdown source={entry.body} />
          {entry.workpackage?.tasks && <section>
            <h3>{t("wp.tasks")}</h3>
            <ul>{entry.workpackage.tasks.map((task) => <li key={task.n}>
              {t("wp.taskLabel", { n: task.n })}: {task.title}{" · "}
              <span>{t(task.status === "pending" ? "wp.task.pending" : task.status === "verified" ? "share.commitsCheckedOnly" : `impl.${task.status}`)}</span>
              {task.inferred && <> · <span>{t("basis.inferred")}</span></>}
            </li>)}</ul>
          </section>}
          {(Array.isArray(entry.quotes) ? entry.quotes : []).map((quote, index) => (
            <blockquote key={`${index}-${quote.text}`}>{quote.text}</blockquote>
          ))}
        </article>
      ) : null}
    </main>
  );
}
