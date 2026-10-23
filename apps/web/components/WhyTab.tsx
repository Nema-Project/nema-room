"use client";

import { Markdown } from "@/components/Markdown";
import { useT } from "@/lib/i18n";
import type { ParagraphBlame } from "@/lib/types";

export function WhyTab({ blame, onSelectVersion }: { blame: ParagraphBlame[]; onSelectVersion: (version: number) => void }) {
  const t = useT();
  return (
    <div className="why">
      <p className="why-intro">{t("why.intro")}</p>
      {blame.map((p, i) => (
        <div key={i} className="why-row" data-testid="why-row">
          <div className="why-left">
            <div className="why-ver">{`v${p.version} · ${t(`author.${p.author}`)}`}</div>
            <button type="button" className="why-reason" onClick={() => onSelectVersion(p.version)}>{p.reason}</button>
          </div>
          <Markdown source={p.text} />
        </div>
      ))}
    </div>
  );
}
