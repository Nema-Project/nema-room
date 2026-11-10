"use client";

import { Markdown } from "@/components/Markdown";
import { useT } from "@/lib/i18n";

export type ShareListEntry = {
  id: string;
  title: string;
  body?: string;
};

export type ShareEntryView = ShareListEntry & {
  body: string;
  quotes: { text: string }[];
};

export function ShareUnavailable({ temporary }: { temporary?: boolean }) {
  const t = useT();
  return <p>{t(temporary ? "share.temporarilyUnavailable" : "share.linkUnavailable")}</p>;
}

/** Read-only knowledge. It must not import the private hub client. */
export function ShareView({
  token,
  workspaceName,
  entries,
  entry,
}: {
  token: string;
  workspaceName: string;
  entries: ShareListEntry[];
  entry?: ShareEntryView;
}) {
  return (
    <main>
      <h1>{workspaceName}</h1>
      <ul>
        {entries.map((item) => (
          <li key={item.id}>
            <a href={`/s/${token}/e/${item.id}`}>{item.title}</a>
          </li>
        ))}
      </ul>
      {entry ? (
        <article>
          <Markdown source={entry.body} />
          {(Array.isArray(entry.quotes) ? entry.quotes : []).map((quote, index) => (
            <blockquote key={`${index}-${quote.text}`}>{quote.text}</blockquote>
          ))}
        </article>
      ) : null}
    </main>
  );
}
