"use client";

import { useParams } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";

function safeDecode(v: string) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export default function WorkspaceRoom() {
  const { id } = useParams<{ id: string }>();
  return <WorkspaceShell routeId={safeDecode(id)} />;
}
