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
  const params = useParams<{ id: string }>();
  if (!params?.id) return null;
  return <WorkspaceShell routeId={safeDecode(params.id)} />;
}
