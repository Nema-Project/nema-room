"use client";

import { Component, useEffect, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import type { EntryDetail } from "@/components/EntryDetail";
import { useT } from "@/lib/i18n";

type EntryDetailProps = ComponentProps<typeof EntryDetail>;

/** Same presentation as EntryDetail's own data-loading state. */
function EntryDetailLoading() {
  const t = useT();
  return (
    <div className="detail">
      <p className="placeholder">{t("common.loading")}</p>
    </div>
  );
}

/** Same presentation as EntryDetail's own data-load failure, close button included. */
function EntryDetailLoadError({ message, onClose }: { message: string; onClose: () => void }) {
  const t = useT();
  return (
    <div className="detail">
      <div className="detail-head">
        <button type="button" className="x" aria-label={t("common.close")} onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="error" role="alert">
        {t("detail.loadFailed", { message })}
      </p>
    </div>
  );
}

/**
 * A throw while the loaded detail subtree renders would tear down the whole
 * shell without a boundary. Show the detail column's existing error
 * presentation instead. The boundary remounts with the caller's key (per
 * entry), so reopening an entry starts from a clean state.
 */
class EntryDetailErrorBoundary extends Component<
  { onClose: () => void; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) return <EntryDetailLoadError message={this.state.error.message} onClose={this.props.onClose} />;
    return this.props.children;
  }
}

/**
 * Lazy boundary for the entry detail subtree (EntryDetail, WorkPackageDetail,
 * HistoryTab, WhyTab). The detail column only renders after an entry is
 * opened, so the subtree stays out of the first-load chunks; the chunk loads
 * in parallel with the getEntry request the open already waits on.
 *
 * The subtree is loaded with a plain import() per mount, not next/dynamic:
 * React.lazy caches a rejected import on its resource, so a module-level
 * loadable would re-expose the same rejection on every remount and entry
 * details would stay unavailable until a page reload. Callers mount this
 * component per entry open (keyed per entry), so each mount makes a fresh
 * import attempt and reopening after a failed load retries it. A rejected
 * import is reported through the detail column's error presentation; the
 * boundary below covers a throw while the loaded component renders.
 *
 * The loader is an optional prop (defaulting to the real import) so tests can
 * drive the rejection path directly: a rejected module mock cannot be made
 * to succeed on a second import within one test file.
 */
type EntryDetailModule = { EntryDetail: ComponentType<EntryDetailProps> };
type EntryDetailLoader = () => Promise<EntryDetailModule>;
const defaultEntryDetailLoader: EntryDetailLoader = () => import("@/components/EntryDetail");

export function EntryDetailLazy({
  loadEntryDetail = defaultEntryDetailLoader,
  ...props
}: EntryDetailProps & { loadEntryDetail?: EntryDetailLoader }) {
  const [Loaded, setLoaded] = useState<ComponentType<EntryDetailProps> | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadEntryDetail().then(
      (mod) => {
        if (!cancelled) setLoaded(() => mod.EntryDetail);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadEntryDetail]);
  if (loadError) return <EntryDetailLoadError message={loadError.message} onClose={props.onClose} />;
  return (
    <EntryDetailErrorBoundary onClose={props.onClose}>
      {Loaded ? <Loaded {...props} /> : <EntryDetailLoading />}
    </EntryDetailErrorBoundary>
  );
}
