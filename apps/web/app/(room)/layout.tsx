import { AppReleaseBanner } from "@/components/AppRelease";
import { DesktopTitlebar } from "@/components/DesktopTitlebar";
import { ThreadWindowsProvider } from "@/components/ThreadWindowsProvider";
import { runtimeHubUrl } from "@/lib/runtimeHubUrl";

// The published image reads NEMA_HUB_URL when a request arrives. A prerendered
// page would freeze the build-time fallback into the HTML.
export const dynamic = "force-dynamic";

export default function RoomLayout({ children }: { children: React.ReactNode }) {
  const hubUrl = runtimeHubUrl();
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: `window.__NEMA_HUB_URL__=${JSON.stringify(hubUrl)}` }} />
      <ThreadWindowsProvider>
        <DesktopTitlebar />
        <AppReleaseBanner />
        {children}
      </ThreadWindowsProvider>
    </>
  );
}
