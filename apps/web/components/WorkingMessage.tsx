"use client";

import { AgentAvatar } from "@/components/MessageItem";
import { useT } from "@/lib/i18n";

export function WorkingMessage({ progress, drawingDiagram = false }: { progress: string; drawingDiagram?: boolean }) {
  const t = useT();
  const label = t(drawingDiagram && !progress ? "chat.drawingDiagram" : "chat.working");
  return (
    <div className="msg">
      <AgentAvatar />
      <div>
        <div className="who">Nema</div>
        <div className="working">
          <span className="bar2" />
          {progress ? `${label} · ${progress}` : label}
        </div>
      </div>
    </div>
  );
}
