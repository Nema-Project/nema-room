"use client";

import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const SAFE = /^(https?:|mailto:)/i;
const ENTRY_HREF = "nema-entry:";
const MARKER = /\[([RDTQSG]-[1-9]\d*)\]/g;

function BaseLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  if (!href || !SAFE.test(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// Raw HTML is never enabled (no rehype-raw): it renders as literal text. Only http(s)/mailto links become anchors.
const base: Components = {
  a: BaseLink,
  img({ alt }) {
    return <span>{alt}</span>;
  },
};

const plainTransform = (url: string) => (SAFE.test(url) ? url : "");
const entryTransform = (url: string) => (url.startsWith(ENTRY_HREF) || SAFE.test(url) ? url : "");

/**
 * With `onOpenEntry`, source markers such as `[R-3]` or `[D-12]` become buttons that open that entry.
 * Without it the text renders as written.
 */
export function Markdown({ source, onOpenEntry }: { source: string; onOpenEntry?: (entryId: string) => void }) {
  const components = useMemo<Components>(
    () =>
      onOpenEntry
        ? {
            ...base,
            a(props) {
              const { href, children } = props;
              if (href?.startsWith(ENTRY_HREF)) {
                const id = href.slice(ENTRY_HREF.length);
                return (
                  <button type="button" className="link mark" onClick={() => onOpenEntry(id)}>
                    {children}
                  </button>
                );
              }
              return <BaseLink {...props} />;
            },
          }
        : base,
    [onOpenEntry],
  );
  const text = onOpenEntry ? source.replace(MARKER, (_m, id: string) => `[\\[${id}\\]](${ENTRY_HREF}${id})`) : source;
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={onOpenEntry ? entryTransform : plainTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
