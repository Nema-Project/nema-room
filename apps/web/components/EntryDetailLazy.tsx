"use client";

import dynamic from "next/dynamic";
import { Component, type ComponentProps, type ReactNode } from "react";
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
 * A failed chunk load rejects the lazy component during render; without a
 * boundary that would tear down the whole shell. Show the detail column's
 * existing error presentation instead. The boundary remounts with the caller's
 * key (per entry), so reopening an entry retries the load.
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

const EntryDetailDynamic = dynamic(() => import("@/components/EntryDetail").then((mod) => mod.EntryDetail), {
  loading: () => <EntryDetailLoading />,
});

/**
 * Lazy boundary for the entry detail subtree (EntryDetail, WorkPackageDetail,
 * HistoryTab, WhyTab). The detail column only renders after an entry is
 * opened, so the subtree stays out of the first-load chunks; the chunk loads
 * in parallel with the getEntry request the open already waits on.
 */
export function EntryDetailLazy(props: EntryDetailProps) {
  return (
    <EntryDetailErrorBoundary onClose={props.onClose}>
      <EntryDetailDynamic {...props} />
    </EntryDetailErrorBoundary>
  );
}
